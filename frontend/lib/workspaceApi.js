const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:5050";

async function handle(res) {
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch {
      // Response wasn't JSON — fall back to statusText.
    }
    throw new Error(detail);
  }
  return res.json();
}

export async function listChannels(memberEmail) {
  const params = new URLSearchParams({ member_email: memberEmail });
  const res = await fetch(`${API_BASE_URL}/channels?${params}`);
  return handle(res);
}

export async function createChannel({ name, type = "project", memberEmails = [], createdBy }) {
  const res = await fetch(`${API_BASE_URL}/channels`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      type,
      member_emails: memberEmails,
      created_by: createdBy,
    }),
  });
  return handle(res);
}

export async function addChannelMember(channelId, { email, addedBy }) {
  const res = await fetch(`${API_BASE_URL}/channels/${channelId}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, added_by: addedBy }),
  });
  return handle(res);
}

export async function listMessages(channelId, { requesterEmail, since, limit = 200 }) {
  const params = new URLSearchParams({ requester_email: requesterEmail, limit: String(limit) });
  if (since) params.set("since", since);
  const res = await fetch(`${API_BASE_URL}/channels/${channelId}/messages?${params}`);
  return handle(res);
}

export async function postMessage(channelId, { senderEmail, text, attachments = [] }) {
  const res = await fetch(`${API_BASE_URL}/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sender_email: senderEmail, text, attachments }),
  });
  return handle(res);
}

export async function sendHeartbeat(email) {
  const res = await fetch(`${API_BASE_URL}/presence/heartbeat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  return handle(res);
}

export async function getPresence(emails) {
  if (!emails.length) return [];
  const params = new URLSearchParams({ emails: emails.join(",") });
  const res = await fetch(`${API_BASE_URL}/presence?${params}`);
  return handle(res);
}