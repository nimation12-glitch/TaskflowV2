# GPU rental — deployment checklist

This feature does not simulate anything. Nothing here works until every step
below is done for real. Read this before flipping it on in production.

## 1. AWS account setup
1. Create a scoped IAM user — **not root credentials**. Attach the policy in
   `infra/aws-iam-policy.json` (region is hardcoded to `eu-west-2` in that
   file — edit the `aws:RequestedRegion` condition if you deploy elsewhere).
2. Pick a real AMI in that region for each tier (a recent NVIDIA Deep Learning
   AMI works well for `g4dn`/`g5` instance families) and set `GpuType.ami_id`
   for each of the 4 seeded tiers. **Nothing will provision without this** —
   `launch_instance` refuses to run against an unset AMI rather than guessing.
3. Set `GpuType.enabled = True` per tier only once you've confirmed the AMI
   actually boots and has GPU drivers installed. All 4 tiers seed as
   `enabled=False` — a tier only shows up in `GET /compute/gpu-types` once
   you've turned it on.

## 2. Environment variables
Add to your production environment (see `.env.example` for the full list):
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`
- `GPU_SWEEP_SERVICE_SECRET` — generate with
  `python -c "import secrets; print(secrets.token_urlsafe(64))"`.
  This is deliberately **not** the same secret as `BACKEND_SERVICE_SECRET`.

`validate_production_config()` will refuse to start the app in production if
any of these are missing — this is intentional, not a bug to work around.

## 3. Database
Run the migration, then re-seed:
```
alembic upgrade head
python -m scripts.seed
```
The migration adds the new columns/tables with safe, restrictive defaults
(0 concurrent rentals, booking disabled, etc.) — `scripts/seed.py` is what
actually sets the real per-plan limits and the GPU catalog. It's safe to
re-run any time.

## 4. The safety sweep cron — do not skip this
`POST /internal/gpu/sweep` (protected by `GPU_SWEEP_SERVICE_SECRET` in the
`X-Taskflow-Service-Secret` header) **must be called every 2–5 minutes** by
an external scheduler — Render's own Cron Jobs feature, or a free service
like cron-job.org. Lazy, request-triggered billing only runs when someone
is actually looking at a dashboard page. A rental nobody is watching keeps
running — and keeps costing real AWS money — until something calls this
endpoint. This is the mechanism that catches that. It is not optional.

## 5. Known gaps worth knowing about
- **Booking payment succeeds but AWS provisioning then fails**: this can
  happen (capacity, quota limits, etc.). Stripe has already captured the
  money at that point. The rental is marked `FAILED` with a clear
  `error_detail`, but there's no automatic refund flow — that needs a human
  to look at the Stripe dashboard and decide. Given how rarely this should
  fire in practice, building automatic refunds felt like more surface area
  than the current stage of the product needs, but it's a reasonable next
  addition once real usage volume makes manual review annoying.
- **Frontend status handling**: `rentals-list.tsx` doesn't have a case for a
  `PENDING_PAYMENT` or `STOPPING` status, so the backend never returns them
  to that endpoint (see code comments in `app/services/gpu_rentals.py` and
  `app/services/gpu_billing.py`). Stop/start settle immediately to
  `STOPPED`/`PROVISIONING` rather than exposing a transitional state — if the
  underlying AWS call is still catching up, the sweep or the next dashboard
  load reconciles it. This works fine but is a slight simplification versus
  a fully real-time status; if you want a true `STOPPING` state shown to
  users later, that's a small frontend addition plus removing the
  workaround in `stop_rental()`.
