import crypto from "crypto";
import { NextResponse } from "next/server";
import clientPromise from "../../../../../lib/mongodb";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const rawToken = searchParams.get("token");
  const baseUrl = process.env.NEXTAUTH_URL || new URL(request.url).origin;

  function redirect(status, reason) {
    const url = new URL("/profile", baseUrl);
    url.searchParams.set("emailChange", status);
    if (reason) url.searchParams.set("reason", reason);
    return NextResponse.redirect(url);
  }

  if (!rawToken) {
    return redirect("error", "missing_token");
  }

  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

  const client = await clientPromise;
  const users = client.db().collection("users");
  const changeTokens = client.db().collection("emailChangeTokens");

  const tokenDoc = await changeTokens.findOne({ tokenHash });
  if (!tokenDoc) {
    return redirect("error", "invalid_token");
  }
  if (tokenDoc.expiresAt < new Date()) {
    await changeTokens.deleteOne({ _id: tokenDoc._id });
    return redirect("error", "expired");
  }

  // Re-check uniqueness at confirmation time too, in case someone else
  // claimed the address while this link was sitting unconfirmed.
  const existing = await users.findOne({
    email: tokenDoc.newEmail,
    _id: { $ne: tokenDoc.userId },
  });
  if (existing) {
    await changeTokens.deleteOne({ _id: tokenDoc._id });
    return redirect("error", "email_taken");
  }

  await users.updateOne(
    { _id: tokenDoc.userId },
    { $set: { email: tokenDoc.newEmail, updatedAt: new Date() } }
  );
  await changeTokens.deleteOne({ _id: tokenDoc._id });

  // Clips and snapshots are attributed by owner_email (the backend's
  // schema), not a stable user id — without this, a researcher's saved
  // clips and Discovery Snapshots would silently stop showing as "theirs"
  // the moment their login email changes. Backend collections live in the
  // explicit "telesto" database (see backend/app/db.py), which may differ
  // from this client's default db, so name it explicitly here.
  const telesto = client.db("telesto");
  try {
    await telesto
      .collection("clips")
      .updateMany({ owner_email: tokenDoc.oldEmail }, { $set: { owner_email: tokenDoc.newEmail } });
    await telesto
      .collection("snapshots")
      .updateMany({ owner_email: tokenDoc.oldEmail }, { $set: { owner_email: tokenDoc.newEmail } });
  } catch (err) {
    // The email change itself already succeeded — don't fail the whole
    // confirmation over this. Worst case, historical clips/snapshots stay
    // attributed to the old address and need a manual fix.
    console.error("Failed to migrate clips/snapshots to new email:", err);
  }

  return redirect("success");
}