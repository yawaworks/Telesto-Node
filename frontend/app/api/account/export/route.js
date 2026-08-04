import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { ObjectId } from "mongodb";
import { authOptions } from "../../auth/[...nextauth]/route";
import clientPromise from "../../../../lib/mongodb";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !session?.user?.email) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const client = await clientPromise;
  const users = client.db().collection("users");
  const userId = new ObjectId(session.user.id);
  const user = await users.findOne({ _id: userId });

  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  const email = user.email;

  // Only clips/snapshots this user actually owns (scope=mine) — a
  // shared team clip someone ELSE uploaded isn't this user's personal
  // data to export, even if they can currently see it in the shared
  // library.
  let clips = [];
  let snapshots = [];

  try {
    const res = await fetch(
      `${API_BASE_URL}/clips?scope=mine&owner_email=${encodeURIComponent(email)}`
    );
    if (res.ok) clips = await res.json();
  } catch (err) {
    console.error("Export: failed to fetch clips:", err);
  }

  try {
    const res = await fetch(
      `${API_BASE_URL}/snapshots?scope=mine&owner_email=${encodeURIComponent(email)}`
    );
    if (res.ok) snapshots = await res.json();
  } catch (err) {
    console.error("Export: failed to fetch snapshots:", err);
  }

  // Deliberately excludes hashedPassword, twoFactorSecret, and
  // twoFactorBackupCodes — those are account-security material, not
  // "your data" in the sense this export is for, and including them
  // would turn a data-portability feature into a credential leak if the
  // downloaded file were ever intercepted or stored insecurely.
  const exportData = {
    exportedAt: new Date().toISOString(),
    account: {
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
      twoFactorEnabled: Boolean(user.twoFactorEnabled),
    },
    profile: user.profile || {},
    clips: clips.map((c) => ({
      name: c.name,
      url: c.url,
      shared: c.shared,
      created_at: c.created_at,
    })),
    snapshots: snapshots.map((s) => ({
      url: s.url,
      captured_at: s.captured_at,
      telemetry: s.telemetry,
      species_query: s.species_query,
      measurements: s.measurements,
      shared: s.shared,
    })),
    notes: [
      "This export includes clips and snapshots owned by your account, plus your profile data.",
      "Media files themselves (video/image bytes) are not included — the 'url' fields link to the hosted files, which remain accessible as long as your account exists.",
      "Snapshots captured before account-ownership tracking was added to this feature may not appear here even if you originally created them.",
    ],
  };

  const json = JSON.stringify(exportData, null, 2);

  return new NextResponse(json, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="telesto-node-data-export-${Date.now()}.json"`,
    },
  });
}