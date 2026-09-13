import Link from "next/link";
import { LogoWordmark } from "@/components/logo-mark";

export default function TermsPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <Link href="/">
        <LogoWordmark size={28} />
      </Link>
      <h1 className="mt-6 text-2xl font-semibold tracking-tight">Terms of Service</h1>
      <p className="mt-2 text-sm text-muted-foreground">Last updated 13 September 2026.</p>

      <div className="mt-8 space-y-6 text-sm leading-relaxed text-muted-foreground">
        <section>
          <h2 className="text-base font-medium text-foreground">1. The service</h2>
          <p className="mt-2">
            TaskFlow provides on-demand rental of dedicated GPU compute instances, billed either pay-as-you-go from a
            reloadable wallet or as a fixed upfront booking. Availability, specifications, and pricing for each GPU
            tier are shown in-app and may change with notice.
          </p>
        </section>
        <section>
          <h2 className="text-base font-medium text-foreground">2. Your account</h2>
          <p className="mt-2">
            You're responsible for activity under your account and for keeping your credentials and SSH keys
            secure. Organizations may invite team members, who inherit access according to their assigned role.
          </p>
        </section>
        <section>
          <h2 className="text-base font-medium text-foreground">3. Acceptable use</h2>
          <p className="mt-2">
            Rented instances may not be used for illegal activity, to violate the rights of others, or to circumvent
            the security or metering of the service. We may suspend or terminate instances found in violation
            without prior notice.
          </p>
        </section>
        <section>
          <h2 className="text-base font-medium text-foreground">4. Billing</h2>
          <p className="mt-2">
            Pay-as-you-go rentals are metered hourly against your wallet balance and auto-stop if the balance can't
            cover the next billing tick. Bookings are charged in full upfront and are non-refundable once
            provisioning begins, except where required by law.
          </p>
        </section>
        <section>
          <h2 className="text-base font-medium text-foreground">5. Termination</h2>
          <p className="mt-2">
            You may terminate a rental or close your account at any time. We may suspend the service, in whole or in
            part, for maintenance, non-payment, or violation of these terms.
          </p>
        </section>
        <section>
          <h2 className="text-base font-medium text-foreground">6. Disclaimers</h2>
          <p className="mt-2">
            The service is provided "as is" without warranties of any kind. We're not liable for data loss on a
            terminated instance — back up anything you need to keep before terminating or letting a booking expire.
          </p>
        </section>
        <section>
          <h2 className="text-base font-medium text-foreground">7. Changes</h2>
          <p className="mt-2">
            We may update these terms from time to time. Continued use of the service after a change constitutes
            acceptance of the updated terms.
          </p>
        </section>
      </div>
    </div>
  );
}
