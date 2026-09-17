/**
 * Zendesk write-back.
 *
 * Every request here is an EXTERNAL API request — it originates on this server,
 * not from the Apps framework — so Marketplace apps must identify themselves
 * with the X-Zendesk-Marketplace-* headers. ZAF's own client.request() is
 * exempt; this is not.
 */

/**
 * Creates Basic Auth header for Zendesk API calls using Email + API Token
 */
function getAuthHeader(email, apiToken) {
  if (email && apiToken) {
    const credentials = `${email}/token:${apiToken}`;
    return `Basic ${Buffer.from(credentials).toString('base64')}`;
  }
  return null;
}

/**
 * Identification headers required of Marketplace apps on external API requests.
 * Organization ID comes from the Organization page at apps.zendesk.com; App ID
 * is assigned when the app is accepted and appears on its tile under Approved
 * Apps. Both are blank until then, and omitted rather than sent empty.
 */
function marketplaceHeaders() {
  const headers = {};
  const name = process.env.ZENDESK_MARKETPLACE_NAME;
  const orgId = process.env.ZENDESK_MARKETPLACE_ORG_ID;
  const appId = process.env.ZENDESK_MARKETPLACE_APP_ID;
  if (name) headers['X-Zendesk-Marketplace-Name'] = name;
  if (orgId) headers['X-Zendesk-Marketplace-Organization-Id'] = orgId;
  if (appId) headers['X-Zendesk-Marketplace-App-Id'] = appId;
  return headers;
}

/**
 * Sync call to Zendesk using Option B (Talk Partner Edition APIs) with fallback to Option A (Standard Tickets API)
 */
async function syncCallToZendesk({
  subdomain,
  email,
  apiToken,
  ticketId,
  fromNumber,
  toNumber,
  duration,
  recordingUrl,
  callDirection = 'Outbound',
  notes = '',
  requesterId = null
}) {
  if (!subdomain) {
    throw new Error('Zendesk subdomain is required for backend API sync');
  }

  const authHeader = getAuthHeader(email, apiToken);
  const headers = {
    'Content-Type': 'application/json',
    ...marketplaceHeaders()
  };
  if (authHeader) {
    headers['Authorization'] = authHeader;
  }

  const baseUrl = `https://${subdomain}.zendesk.com`;
  const callDurationSec = parseInt(duration, 10) || 0;
  const startedAt = new Date().toISOString();

  console.log(`[Zendesk Service] Attempting Option B (Talk Partner Edition) call sync for ticket #${ticketId || 'NEW'}`);

  // Option B Strategy 1: Inject Voice Comment into an existing Ticket
  if (ticketId) {
    try {
      const voiceCommentUrl = `${baseUrl}/api/v2/tickets/${ticketId}/voice_comment.json`;
      const voiceCommentBody = {
        voice_comment: {
          from: fromNumber || 'Unknown',
          to: toNumber || 'Unknown',
          recording_url: recordingUrl || '',
          started_at: startedAt,
          call_duration: callDurationSec,
          body: notes ? `[VoBiz ${callDirection} Call]\n${notes}` : `[VoBiz ${callDirection} Call]`
        }
      };

      console.log(`[Zendesk Service] Calling TPE Voice Comment API: ${voiceCommentUrl}`);
      const tpeRes = await fetch(voiceCommentUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(voiceCommentBody)
      });

      if (tpeRes.ok) {
        const tpeData = await tpeRes.json();
        console.log(`[Zendesk Service] Successfully injected TPE voice comment into ticket #${ticketId}`);
        return { success: true, mode: 'tpe_voice_comment', ticketId, data: tpeData };
      } else {
        const errorText = await tpeRes.text();
        console.warn(`[Zendesk Service] TPE Voice Comment API returned status ${tpeRes.status}: ${errorText}. Falling back to standard ticket comment.`);
      }
    } catch (err) {
      console.warn('[Zendesk Service] TPE Voice Comment API failed with error:', err.message);
    }
  }

  // Option B Strategy 2: Create a new Voice Ticket via /api/v2/channels/voice/tickets.json
  if (!ticketId) {
    try {
      const voiceTicketUrl = `${baseUrl}/api/v2/channels/voice/tickets.json`;
      const voiceTicketBody = {
        display_to_agent: 1,
        ticket: {
          subject: `VoBiz ${callDirection} Call with ${fromNumber || toNumber || 'Customer'}`,
          type: 'task',
          status: 'solved',
          requester_id: requesterId ? parseInt(requesterId, 10) : null
        },
        voice_comment: {
          from: fromNumber || 'Unknown',
          to: toNumber || 'Unknown',
          recording_url: recordingUrl || '',
          started_at: startedAt,
          call_duration: callDurationSec,
          body: notes ? `[VoBiz ${callDirection} Call]\n${notes}` : `[VoBiz ${callDirection} Call]`
        }
      };

      console.log(`[Zendesk Service] Calling TPE Voice Ticket API: ${voiceTicketUrl}`);
      const tpeRes = await fetch(voiceTicketUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(voiceTicketBody)
      });

      if (tpeRes.ok) {
        const tpeData = await tpeRes.json();
        const createdTicketId = tpeData.ticket ? tpeData.ticket.id : null;
        console.log(`[Zendesk Service] Successfully created TPE Voice Ticket #${createdTicketId}`);
        return { success: true, mode: 'tpe_voice_ticket', ticketId: createdTicketId, data: tpeData };
      } else {
        const errorText = await tpeRes.text();
        console.warn(`[Zendesk Service] TPE Voice Ticket API returned status ${tpeRes.status}: ${errorText}. Falling back to standard tickets API.`);
      }
    } catch (err) {
      console.warn('[Zendesk Service] TPE Voice Ticket API failed with error:', err.message);
    }
  }

  // Option A Fallback: Standard Tickets API
  console.log('[Zendesk Service] Executing Option A (Standard Tickets API Fallback)...');
  const formattedMinutes = String(Math.floor(callDurationSec / 60)).padStart(2, '0');
  const formattedSeconds = String(callDurationSec % 60).padStart(2, '0');

  const logBody = `[VoBiz Call Log]\n` +
                  `Date: ${new Date().toLocaleString()}\n` +
                  `Direction: ${callDirection}\n` +
                  `From: ${fromNumber || 'N/A'}\n` +
                  `To: ${toNumber || 'N/A'}\n` +
                  `Duration: ${formattedMinutes}:${formattedSeconds}\n` +
                  (recordingUrl ? `Recording: 🎧 [Listen to Call Recording](${recordingUrl})\n` : '') +
                  `Notes: ${notes || 'No notes provided.'}`;

  if (ticketId) {
    const updateUrl = `${baseUrl}/api/v2/tickets/${ticketId}.json`;
    const res = await fetch(updateUrl, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        ticket: {
          comment: {
            body: logBody,
            public: false
          }
        }
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Standard ticket update failed with status ${res.status}: ${errText}`);
    }
    const data = await res.json();
    return { success: true, mode: 'standard_ticket_update', ticketId, data };
  } else {
    const createUrl = `${baseUrl}/api/v2/tickets.json`;
    const res = await fetch(createUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ticket: {
          subject: `Call Log - ${fromNumber || toNumber || 'Customer'}`,
          comment: {
            body: logBody,
            public: false
          },
          type: 'task',
          status: 'solved',
          requester_id: requesterId ? parseInt(requesterId, 10) : null
        }
      })
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Standard ticket creation failed with status ${res.status}: ${errText}`);
    }
    const data = await res.json();
    const createdTicketId = data.ticket ? data.ticket.id : null;
    return { success: true, mode: 'standard_ticket_create', ticketId: createdTicketId, data };
  }
}

/**
 * Appends full VoBiz / Vapi conversation transcript into Zendesk ticket as a private internal note
 */
async function appendTranscription({
  subdomain,
  email,
  apiToken,
  ticketId,
  transcript,
  callId = ''
}) {
  if (!subdomain || !ticketId || !transcript) {
    throw new Error('Missing required fields for transcription append: subdomain, ticketId, transcript');
  }

  const authHeader = getAuthHeader(email, apiToken);
  const headers = {
    'Content-Type': 'application/json',
    ...marketplaceHeaders()
  };
  if (authHeader) {
    headers['Authorization'] = authHeader;
  }

  const updateUrl = `https://${subdomain}.zendesk.com/api/v2/tickets/${ticketId}.json`;
  const transcriptBody = `[VoBiz AI Conversation Transcript${callId ? ` - Call #${callId}` : ''}]\n\n${transcript}`;

  console.log(`[Zendesk Service] Appending AI transcript to Zendesk ticket #${ticketId}`);

  const res = await fetch(updateUrl, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      ticket: {
        comment: {
          body: transcriptBody,
          public: false
        }
      }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Transcription append failed with status ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return { success: true, ticketId, data };
}

module.exports = {
  syncCallToZendesk,
  appendTranscription
};
