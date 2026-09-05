import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { bootstrapOrganization } from "@/lib/backend-internal";

const bodySchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  password: z.string().min(8).max(200),
});

export async function POST(request: Request) {
  const json = await request.json().catch(() => null);
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.flatten() }, { status: 400 });
  }
  const { name, email, password } = parsed.data;
  const normalizedEmail = email.toLowerCase();

  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing) {
    // Do not reveal whether the account has a password vs OAuth-only —
    // generic message either way (mitigates user enumeration, docs §33).
    return NextResponse.json(
      { error: "Could not create account with these details." },
      { status: 400 }
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const user = await prisma.user.create({
    data: { name, email: normalizedEmail, passwordHash },
  });

  // The Prisma adapter's createUser event only fires for adapter-driven
  // (OAuth) signups, so we bootstrap explicitly here for credentials signups.
  await bootstrapOrganization({ userId: user.id, displayName: name, email: normalizedEmail });

  // Email verification: a real transactional email would be sent here via
  // lib/email.ts (see that file for the provider abstraction and the
  // explicit production requirement that EMAIL_PROVIDER=console is rejected
  // outside development).

  return NextResponse.json({ ok: true });
}
