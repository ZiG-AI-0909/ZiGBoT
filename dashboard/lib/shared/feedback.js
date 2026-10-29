/**
 * First-purchase Premium feedback: the questions, options and validation,
 * shared by the dashboard form and its API (and the admin view). CommonJS,
 * like the rest of lib/shared.
 *
 * One form for both plans. The plan (monthly ₹399 / yearly ₹3,999) and
 * the amount always come from the verified purchase record, never from the
 * browser; the plan only decides which extra questions are asked.
 */
const PLAN_PERIODS = Object.freeze(['monthly', 'yearly']);

const OPTIONS = Object.freeze({
    purchase_reasons: Object.freeze([
        ['premium_features', 'Unlocking premium features'],
        ['server_management', 'Better server management'],
        ['ai_personas', 'AI chatbot and custom personas'],
        ['automation_moderation', 'Automation and moderation features'],
        ['support_dev', 'Supporting ZiGBoT development'],
        ['customization', 'Better customization'],
        ['recommendation', 'Recommendation from a friend or community'],
        ['other', 'Other']
    ]),
    // Only features that exist today (none are "coming soon").
    valuable_features: Object.freeze([
        ['ai_personas', 'AI chatbot and personas'],
        ['memory', 'Conversation memory'],
        ['custom_server', 'Custom server features (custom persona, bot identity)'],
        ['moderation_security', 'Moderation and security tools'],
        ['anti_nuke', 'Anti-Nuke protection'],
        ['automation', 'Automation (scheduled greetings)'],
        ['customization_roles', 'Customization and role management'],
        ['music_voice', 'Music and voice chat'],
        ['other', 'Other']
    ]),
    value_for_money: Object.freeze([
        ['excellent', 'Excellent value'],
        ['good', 'Good value'],
        ['fair', 'Fair for the price'],
        ['too_expensive', 'Too expensive'],
        ['need_time', 'I need more time to evaluate it']
    ]),
    issues: Object.freeze([
        ['none', 'No issues so far'],
        ['hard_to_understand', 'Features are difficult to understand'],
        ['not_working', 'Bot commands or features aren\'t working'],
        ['activation_payment', 'Premium activation or payment issue'],
        ['performance', 'Performance or reliability issues'],
        ['other', 'Other']
    ]),
    // ₹399 (monthly) only.
    meets_expectations: Object.freeze([
        ['yes', 'Yes, fully'],
        ['partly', 'Partly'],
        ['no', 'Not yet']
    ]),
    // ₹3,999 (yearly) only.
    justifies_price: Object.freeze([
        ['yes', 'Yes'],
        ['mostly', 'Mostly'],
        ['not_yet', 'Not yet'],
        ['too_early', 'Too early to say']
    ]),
    needs_onboarding: Object.freeze([
        ['yes', 'Yes, I\'d like help setting things up'],
        ['no', 'No, I\'m all set']
    ]),
    advanced_capabilities: Object.freeze([
        ['ai_limits', 'Higher AI reply limits'],
        ['custom_persona', 'Custom persona and templates'],
        ['role_mappings', 'More role mappings'],
        ['music_voice', 'Music and voice chat'],
        ['custom_identity', 'Custom bot name and avatar']
    ]),
    meets_requirements: Object.freeze([
        ['yes', 'Yes, fully'],
        ['partly', 'Partly'],
        ['no', 'No']
    ])
});

const RATING_LABELS = Object.freeze(['Very Poor', 'Poor', 'Okay', 'Good', 'Excellent']);
const EASE_LABELS = Object.freeze(['Very Difficult', 'Difficult', 'Neutral', 'Easy', 'Very Easy']);
const TEXT_MAX = 2000;
const REMIND_LATER_HOURS = 24;

/** "₹3,999 Premium" from the VERIFIED amount (paise); falls back to the plan name. */
function planLabel({ amount_paise: paise = null, currency = 'INR', plan_period: period = null } = {}) {
    if (Number.isInteger(paise) && paise > 0) {
        const amount = new Intl.NumberFormat('en-IN', { style: 'currency', currency: currency || 'INR', maximumFractionDigits: paise % 100 ? 2 : 0 }).format(paise / 100);
        return `${amount} Premium`;
    }
    return period === 'yearly' ? 'Yearly Premium' : 'Monthly Premium';
}

const keys = (list) => list.map(([key]) => key);
const clean = (value) => String(value ?? '').replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();

/**
 * Validate a submission for a purchase of `planPeriod` (from the database).
 * Returns { ok, value, errors }. Unknown fields are ignored; plan-specific
 * answers go in value.plan_answers.
 */
function validateFeedback(input, { planPeriod }) {
    const src = input && typeof input === 'object' ? input : {};
    const errors = {};
    const int = (field, min, max, label) => {
        const n = Number(src[field]);
        if (src[field] === undefined || src[field] === null || src[field] === '' || !Number.isInteger(n) || n < min || n > max) {
            errors[field] = label;
            return null;
        }
        return n;
    };
    const one = (field, list, required, label) => {
        const value = src[field];
        if (value === undefined || value === null || value === '') {
            if (required) errors[field] = label;
            return null;
        }
        if (!keys(list).includes(value)) {
            errors[field] = label;
            return null;
        }
        return value;
    };
    const many = (field, list) => {
        const raw = Array.isArray(src[field]) ? src[field] : [];
        const allowed = keys(list);
        const picked = [...new Set(raw.map(String))];
        if (picked.some((v) => !allowed.includes(v))) errors[field] = 'Pick from the listed options.';
        return picked.filter((v) => allowed.includes(v));
    };
    const text = (field) => {
        const value = clean(src[field]);
        if (value.length > TEXT_MAX) errors[field] = `At most ${TEXT_MAX} characters.`;
        return value ? value.slice(0, TEXT_MAX) : null;
    };

    const issues = many('issues', OPTIONS.issues);
    if (issues.includes('none') && issues.length > 1) errors.issues = '"No issues so far" can\'t be combined with other issues.';
    const value = {
        overall_rating: int('overall_rating', 1, 5, 'Rate your experience from 1 to 5 stars.'),
        purchase_reasons: many('purchase_reasons', OPTIONS.purchase_reasons),
        valuable_features: many('valuable_features', OPTIONS.valuable_features),
        activation_ease: int('activation_ease', 1, 5, 'Tell us how easy purchasing and activating was.'),
        value_for_money: one('value_for_money', OPTIONS.value_for_money, true, 'Tell us how you feel about the value.'),
        missing_features: text('missing_features'),
        issues,
        issue_details: text('issue_details'),
        recommend_score: int('recommend_score', 0, 10, 'Pick a number from 0 to 10.'),
        comments: text('comments'),
        plan_answers: {}
    };
    if (planPeriod === 'yearly') {
        value.plan_answers = {
            justifies_price: one('justifies_price', OPTIONS.justifies_price, true, 'Tell us whether the yearly plan feels worth it.'),
            needs_onboarding: one('needs_onboarding', OPTIONS.needs_onboarding, true, 'Tell us whether you\'d like setup help.'),
            advanced_capabilities: many('advanced_capabilities', OPTIONS.advanced_capabilities),
            meets_requirements: one('meets_requirements', OPTIONS.meets_requirements, true, 'Tell us whether the plan meets your server\'s needs.')
        };
    } else if (planPeriod === 'monthly') {
        value.plan_answers = {
            meets_expectations: one('meets_expectations', OPTIONS.meets_expectations, true, 'Tell us whether Premium meets your expectations.'),
            more_useful: text('more_useful')
        };
    } else {
        errors.plan = 'Unknown plan.';
    }
    return { ok: Object.keys(errors).length === 0, value, errors };
}

/** Option key -> label, for summaries and exports. */
function optionLabel(field, key) {
    const list = OPTIONS[field];
    return list?.find(([k]) => k === key)?.[1] || key;
}

module.exports = {
    FEEDBACK_PLAN_PERIODS: PLAN_PERIODS,
    FEEDBACK_OPTIONS: OPTIONS,
    FEEDBACK_RATING_LABELS: RATING_LABELS,
    FEEDBACK_EASE_LABELS: EASE_LABELS,
    FEEDBACK_TEXT_MAX: TEXT_MAX,
    FEEDBACK_REMIND_LATER_HOURS: REMIND_LATER_HOURS,
    planLabel,
    validateFeedback,
    optionLabel
};
