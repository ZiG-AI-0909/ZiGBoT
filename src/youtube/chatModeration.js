// Conservative, local-only moderation for YouTube live chat. Common explicit
// English and Hindi/Hinglish profanity is timed out; teasing aimed at the
// streamer or bot gets a short, playful comeback.
const DIRTY_WORDS = [
    'fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'bullshit', 'bitch',
    'asshole', 'dickhead', 'cunt', 'bastard', 'whore', 'slut',
    'bhosdike', 'bhosdi', 'bhosda', 'bsdk', 'chutiya', 'chutiye', 'chutya',
    'gandu', 'gaand', 'madarchod', 'maderchod', 'mc', 'behenchod', 'bhenchod',
    'bkl', 'randi', 'lund', 'loda', 'lavde', 'harami',
    'भोसड़ीके', 'भोसड़ी', 'चूतिया', 'गांडू', 'मादरचोद', 'बहनचोद', 'बहनचूत',
    'रंडी', 'लंड', 'लौड़ा', 'हरामी'
];

const DIRTY_PATTERNS = DIRTY_WORDS.map((word) => new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${word}(?=$|[^\\p{L}\\p{N}])`,
    'iu'
));

const TARGET_PATTERN = /\b(bot|zigbot|streamer|stream|your gameplay|your play|tera stream|teri stream|tumhara stream)\b/i;
const TEASE_PATTERN = /\b(noob|bad|boring|useless|clown|skill issue|can't play|cannot play|bekar|bakwas|faltu|pagal|kya kar raha|kya karte|nahi aata)\b|नहीं आता|बेकार|बकवास|जोकर/i;

const ENGLISH_COMEBACKS = [
    'That roast had less impact than a loading screen—give it another try 😄',
    'Chat, rate that roast: I’m giving it a solid “needs more practice” 😂',
    'Bold words from someone whose punchline is still buffering 😄'
];
const HINGLISH_COMEBACKS = [
    'Roast karne aaye the, punchline loading screen pe atak gayi 😄',
    'Wah, kya roast tha—ab isko thoda aur practice karke aana 😂',
    'Itna halka roast? Chat, isko warm-up round maan lete hain 😄'
];

function hasDirtyLanguage(text) {
    const value = String(text || '').normalize('NFKC');
    return DIRTY_PATTERNS.some((pattern) => pattern.test(value));
}

function getPlayfulRoast(text) {
    const value = String(text || '').normalize('NFKC');
    if (hasDirtyLanguage(value) || !TARGET_PATTERN.test(value) || !TEASE_PATTERN.test(value)) return null;
    const hindiOrHinglish = /[\u0900-\u097f]|\b(tera|teri|tumhara|bekar|bakwas|faltu|pagal|kya|nahi)\b/i.test(value);
    const options = hindiOrHinglish ? HINGLISH_COMEBACKS : ENGLISH_COMEBACKS;
    return options[Math.floor(Math.random() * options.length)];
}

module.exports = { hasDirtyLanguage, getPlayfulRoast };
