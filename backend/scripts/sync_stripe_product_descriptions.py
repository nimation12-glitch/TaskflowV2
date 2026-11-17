"""
Keep the checkout-visible description on every Stripe Product in sync with
the copy defined in code (stripe_service.PLAN_CHECKOUT_TEXT + the wallet
top-up packages), so the Stripe checkout page always tells the buyer
exactly what they are purchasing. Idempotent — only writes when the stored
description differs.

Run standalone (needs STRIPE_SECRET_KEY in the environment):
    python -m scripts.sync_stripe_product_descriptions

Also called best-effort from scripts.seed on each deploy so the live
products pick up copy changes without manual steps. Locally, without a
Stripe key, it is a no-op.

Covers:
  - Subscription prices (Pro / Ultra / Max) — the product description is
    what the checkout page's item panel and the billing portal show.
  - Wallet top-up prices (£10/£25/£50/£100) — shared with the legacy credit
    purchase flow; the wallet is the same ledger under a new label.
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import stripe

from app.config import get_settings
from app.billing.stripe_service import PLAN_CHECKOUT_TEXT
from app.models.billing import PlanCode

logger = logging.getLogger(__name__)

settings = get_settings()

WALLET_AMOUNT_ATTRS: dict[str, int] = {
    "stripe_price_credit_10": 10_000_000,
    "stripe_price_credit_25": 25_000_000,
    "stripe_price_credit_50": 50_000_000,
    "stripe_price_credit_100": 100_000_000,
}


def _target_descriptions() -> dict[str, str]:
    """Stripe price id -> description that should be on its product."""
    targets: dict[str, str] = {
        settings.stripe_price_pro: PLAN_CHECKOUT_TEXT[PlanCode.PRO]["description"],
        settings.stripe_price_ultra: PLAN_CHECKOUT_TEXT[PlanCode.ULTRA]["description"],
        settings.stripe_price_max: PLAN_CHECKOUT_TEXT[PlanCode.MAX]["description"],
    }
    for attr, amount_micros in WALLET_AMOUNT_ATTRS.items():
        price_id = getattr(settings, attr, "")
        if price_id:
            pounds = amount_micros / 1_000_000
            targets[price_id] = (
                f"£{pounds:g} wallet top-up — adds £{pounds:g} of credit to your TaskFlow wallet. "
                f"Pays for GPU compute rentals; credit never expires."
            )
    return {price_id: text for price_id, text in targets.items() if price_id}


def sync_product_descriptions(strict: bool = True) -> int:
    """Returns the number of products updated. strict=True raises on any
    Stripe error (standalone runs); strict=False logs and continues (builds)."""
    if not settings.stripe_secret_key:
        if strict:
            raise SystemExit("STRIPE_SECRET_KEY is not set — refusing to run against anything but live Stripe.")
        logger.warning("STRIPE_SECRET_KEY not set — Stripe product description sync skipped.")
        return 0

    stripe.api_key = settings.stripe_secret_key
    updated = 0
    for price_id, description in _target_descriptions().items():
        try:
            price = stripe.Price.retrieve(price_id)
            product_id = price["product"]
            product = stripe.Product.retrieve(product_id)
            if product.get("description") == description:
                continue
            stripe.Product.modify(product_id, description=description)
            updated += 1
            logger.info("Stripe product %s (%s) description updated", product_id, price_id)
        except Exception:  # noqa: BLE001 — a copy sync must never break a deploy
            if strict:
                raise
            logger.warning("Stripe product description sync failed for price %s", price_id, exc_info=True)
    return updated


def main() -> None:
    updated = sync_product_descriptions(strict=True)
    print(f"Stripe product descriptions synced ({updated} updated).")


if __name__ == "__main__":
    main()
