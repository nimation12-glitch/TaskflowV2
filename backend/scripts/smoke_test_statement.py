"""
One-off smoke test: build an account statement for the first organization
owned by the platform admin, directly through the service layer (no HTTP).
Reads real data from the configured DATABASE_URL; writes exactly one
account_statements row. Safe to re-run.
"""
import uuid
import sys

sys.stdout.reconfigure(encoding="utf-8")

from app.database import SessionLocal
from app.models.org import Membership, Organization
from app.services import statement as statement_service

ADMIN_EMAIL_USER_ID = uuid.UUID("117f49cd-984f-48a0-bf2a-1fe59b9d0b8a")  # nimation12@gmail.com


def main() -> None:
    db = SessionLocal()
    try:
        row = (
            db.query(Membership)
            .filter(Membership.user_id == ADMIN_EMAIL_USER_ID)
            .order_by(Membership.created_at.asc())
            .first()
        )
        if row is None:
            print("No membership found for the admin user — cannot build a statement.")
            return
        org = db.get(Organization, row.organization_id)
        print(f"Organization: {org.name} ({org.id}) role={row.role.value}")

        result = statement_service.generate_statement(db, org.id, ADMIN_EMAIL_USER_ID)
        db.commit()

        content = result["statement"]
        print(f"Snapshot id:    {result['statement_id']}")
        print(f"SHA-256:        {result['content_sha256'][:16]}…")
        print(f"Balance:        {content['credit_balance_display']}")
        print(f"Ledger rows:    {len(content['credit_transactions'])}")
        print(f"Invoices:       {len(content['invoices'])}")
        print(f"GPU rentals:    {len(content['gpu_rentals'])}")
        print(f"Plan:           {content['plan'] and content['plan']['display_name']}")

        # Round-trip verification: read the stored row back and check integrity.
        import uuid as u

        fetched = statement_service.get_statement(db, org.id, u.UUID(result["statement_id"]))
        statement_service.verify_statement(fetched)
        print("Integrity:      OK (stored content matches recorded hash)")
    finally:
        db.close()


if __name__ == "__main__":
    main()
