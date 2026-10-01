// Gmail drafts only. This module has no send path, on purpose.
// Credentials: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN (see scripts/google-auth.js).
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';

let token = { value: null, expires: 0 };

async function accessToken() {
  if (token.value && Date.now() < token.expires - 60000) return token.value;
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('Gmail is not configured. Run `node scripts/google-auth.js`.');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Google token refresh failed: ${data.error_description || data.error}`);
  token = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return token.value;
}

async function gmail(pathname, init = {}) {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json', ...init.headers },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Gmail ${res.status}: ${data.error?.message || res.statusText}`);
  return data;
}

// Headers from the last message in a thread, so the draft lands as a reply in it.
async function threadReplyHeaders(threadId) {
  const t = await gmail(`/threads/${encodeURIComponent(threadId)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject&metadataHeaders=References`);
  const last = t.messages?.at(-1);
  if (!last) return null;
  const h = Object.fromEntries((last.payload?.headers || []).map(x => [x.name.toLowerCase(), x.value]));
  return { messageId: h['message-id'], subject: h.subject || '', references: h.references || '' };
}

const encodeHeader = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`);

async function createDraft({ to, subject, body, threadId }) {
  let reply = null;
  if (threadId) {
    try { reply = await threadReplyHeaders(threadId); } catch { reply = null; }
  }
  const subj = subject || (reply ? (/^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`) : '');
  const headers = [
    to && `To: ${to}`,
    `Subject: ${encodeHeader(subj)}`,
    reply?.messageId && `In-Reply-To: ${reply.messageId}`,
    reply?.messageId && `References: ${`${reply.references} ${reply.messageId}`.trim()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ].filter(Boolean);
  const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`).toString('base64url');
  const message = { raw, ...(reply ? { threadId } : {}) };
  const draft = await gmail('/drafts', { method: 'POST', body: JSON.stringify({ message }) });
  return { id: draft.id, threadId: draft.message?.threadId, inThread: Boolean(reply) };
}

module.exports = { createDraft };
