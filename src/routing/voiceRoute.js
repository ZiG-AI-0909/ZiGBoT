const { destructiveActions, normalizeAction } = require('../tools/router');

// Voice-originated requests may only reach these actions. Anything else
// (admin tools, destructive or not) must be typed in a text channel where the
// authorization and confirmation flows can do their job.
const ALLOWED_VOICE_ACTIONS = new Set([
    'join_voice', 'leave_voice', 'voice_status', 'play', 'pause_music',
    'resume_music', 'skip_music', 'stop_music', 'queue_music', 'now_playing',
    'volume_music', 'loop_music', 'bot_help', 'chat'
]);

function isAllowedVoiceAction(action) {
    return ALLOWED_VOICE_ACTIONS.has(action);
}

// Destructive/admin phrasings detected in a transcript are never executed by
// voice; the speaker is redirected to a text channel for Confirm/Cancel.
const TEXT_ONLY_VOICE_PATTERN = /\b(kick|ban|unban|timeout|warn|delete|remove|create|rename|purge|prune|role|channel|moderate)\b/i;

const VOICE_COMMAND_PATTERNS = [
    { regex: /\b(help|commands?|what can you do)\b/i, action: 'bot_help' },
    { regex: /\b(join( the)? (voice|call|channel)|come (here|in))\b/i, action: 'join_voice' },
    { regex: /\b(leave|disconnect|drop)\b/i, action: 'leave_voice' },
    { regex: /\b(status|where are you|connected)\b/i, action: 'voice_status' },
    { regex: /\bpause\b/i, action: 'pause_music' },
    { regex: /\b(resume|continue)\b/i, action: 'resume_music' },
    { regex: /\b(skip|next (song|track))\b/i, action: 'skip_music' },
    { regex: /\bstop\b/i, action: 'stop_music' },
    { regex: /\bqueue\b/i, action: 'queue_music' },
    { regex: /\b(what.?s playing|now playing)\b/i, action: 'now_playing' },
    { regex: /\bloop\b/i, action: 'loop_music' }
];

// Deterministic keyword routing for the voice path (no LLM call): transcripts
// must never be sent to external services, and voice commands stay predictable.
function buildVoiceTranscriptRoute(routeContext, transcript, settings, botUserId) {
    const text = String(transcript || '').trim();
    const intent = { action: 'chat', target: text };

    if (!text) return intent;

    // play needs a direct HTTPS audio URL in the transcript
    const urlMatch = text.match(/https:\/\/\S+/);
    if (urlMatch && /\b(play|queue)\b/i.test(text)) {
        intent.action = 'play';
        intent.target = urlMatch[0];
        return intent;
    }

    const volumeMatch = text.match(/\bvolume (?:to )?(\d{1,3})\b/i);
    if (volumeMatch) {
        intent.action = 'volume_music';
        intent.volume = Number(volumeMatch[1]);
        return intent;
    }

    for (const { regex, action } of VOICE_COMMAND_PATTERNS) {
        if (regex.test(text)) {
            intent.action = action;
            return intent;
        }
    }

    // Anything that sounds like admin/destructive work is blocked from voice.
    if (TEXT_ONLY_VOICE_PATTERN.test(text) || destructiveActions.has(normalizeAction(text) || '')) {
        intent.action = 'chat';
        intent.voiceNotice = 'That command only works in a text channel, where I can check permissions and confirm anything destructive. Type it there instead.';
        return intent;
    }

    // Belt and braces: an allowed action must be on the voice whitelist.
    if (!isAllowedVoiceAction(intent.action)) {
        intent.action = 'chat';
        intent.voiceNotice = 'That command only works in a text channel. Type it there instead.';
    }

    return intent;
}

module.exports = {
    buildVoiceTranscriptRoute,
    isAllowedVoiceAction,
    ALLOWED_VOICE_ACTIONS
};
