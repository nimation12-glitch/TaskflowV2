import "server-only";

interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

/**
 * Single choke point for all outbound email (verification, password reset,
 * invitations, billing notices). Swapping providers means editing only this
 * file. See docs/AGENTS.md §35.
 */
export async function sendEmail(params: SendEmailParams): Promise<void> {
  const provider = process.env.EMAIL_PROVIDER ?? "console";

  if (provider === "console") {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "EMAIL_PROVIDER=console is not allowed in production. Configure a real " +
          "transactional email provider (set EMAIL_PROVIDER=smtp and SMTP_* env vars)."
      );
    }
    // eslint-disable-next-line no-console
    console.log(`[dev email] to=${params.to} subject="${params.subject}"\n${params.html}`);
    return;
  }

  if (provider === "smtp") {
    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      auth: { user: process.env.SMTP_USERNAME, pass: process.env.SMTP_PASSWORD },
    });
    await transport.sendMail({
      from: process.env.SMTP_FROM_EMAIL ?? "no-reply@taskflow.web-agent.org",
      to: params.to,
      subject: params.subject,
      html: params.html,
    });
    return;
  }

  throw new Error(`Unknown EMAIL_PROVIDER: ${provider}`);
}
