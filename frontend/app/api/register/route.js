import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import clientPromise from "../../../lib/mongodb";
import { registerLimiter, getClientIp } from "../../../lib/rateLimit";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request) {
  const ip = getClientIp(request);
  const { success } = await registerLimiter.limit(ip);
  if (!success) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in a minute." },
      { status: 429 }
    );
  }

  const body = await request.json();
  const rawEmail = body?.email;
  const password = body?.password;
  const name = body?.name;

  if (!rawEmail || !password) {
    return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  }

  const email = rawEmail.trim().toLowerCase();

  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 }
    );
  }

  const client = await clientPromise;
  const users = client.db().collection("users");

  // Pre-check for a fast, friendly error message in the common case.
  // The unique index (see setup script) is the real guarantee against
  // duplicates — this check alone has a race condition under concurrent
  // requests.
  const existing = await users.findOne({ email });
  if (existing) {
    if (!existing.hashedPassword) {
      return NextResponse.json(
        { error: "This email is registered via Google. Continue with Google instead." },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: "An account with this email already exists" }, { status: 409 });
  }

  const hashedPassword = await bcrypt.hash(password, 12);

  try {
    await users.insertOne({
      email,
      name: name || email,
      hashedPassword,
      createdAt: new Date(),
    });
  } catch (err) {
    // E11000 = duplicate key, i.e. two requests raced past the findOne
    // check above. Requires the unique index from the setup script.
    if (err?.code === 11000) {
      return NextResponse.json({ error: "An account with this email already exists" }, { status: 409 });
    }
    throw err;
  }

  return NextResponse.json({ success: true });
}