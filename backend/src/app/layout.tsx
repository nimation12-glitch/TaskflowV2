/**
 * Minimal root layout — the backend serves /api/** route handlers only.
 * The product UI lives in the frontend deployment.
 */
export const metadata = { title: "TaskFlow API" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
