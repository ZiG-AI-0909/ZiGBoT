/**
 * Section G rules with no Discord or storage in them: level maths,
 * achievements, tournament brackets and the trivia question bank.
 */
const crypto = require('node:crypto');

const XP_MIN = 15;
const XP_MAX = 25;
const XP_COOLDOWN_MS = 60_000;
const DAILY_MS = 24 * 3_600_000;
const STREAK_GRACE_MS = 48 * 3_600_000;
const COIN_CAP = 1_000_000_000_000;

/** XP needed to go from level l to l + 1. */
const xpForLevel = (level) => 5 * level * level + 50 * level + 100;

/** { level, into, needed } for a total XP amount. */
function levelFromXp(totalXp) {
    let level = 0;
    let left = Math.max(0, Math.floor(Number(totalXp) || 0));
    while (left >= xpForLevel(level)) {
        left -= xpForLevel(level);
        level += 1;
    }
    return { level, into: left, needed: xpForLevel(level) };
}

/** Random XP for one message, inclusive range 15-25. */
const rollXp = (rng = Math.random) => XP_MIN + Math.floor(rng() * (XP_MAX - XP_MIN + 1));

const ACHIEVEMENTS = Object.freeze([
    { id: 'level_5', name: 'Rising star', emoji: '⭐', test: (m) => levelFromXp(m.xp).level >= 5 },
    { id: 'level_10', name: 'Regular', emoji: '🌟', test: (m) => levelFromXp(m.xp).level >= 10 },
    { id: 'level_25', name: 'Veteran', emoji: '🏅', test: (m) => levelFromXp(m.xp).level >= 25 },
    { id: 'level_50', name: 'Legend', emoji: '👑', test: (m) => levelFromXp(m.xp).level >= 50 },
    { id: 'messages_100', name: 'Chatterbox', emoji: '💬', test: (m) => (m.messages || 0) >= 100 },
    { id: 'messages_1000', name: 'Storyteller', emoji: '📚', test: (m) => (m.messages || 0) >= 1000 },
    { id: 'streak_7', name: 'One-week streak', emoji: '🔥', test: (m) => (m.streak || 0) >= 7 },
    { id: 'streak_30', name: 'One-month streak', emoji: '💎', test: (m) => (m.streak || 0) >= 30 }
]);

/** Achievements newly earned by this member record (not already in m.achievements). */
function newAchievements(member) {
    const have = new Set(member.achievements || []);
    return ACHIEVEMENTS.filter((a) => !have.has(a.id) && a.test(member));
}

/** A fresh member record. */
const blankMember = () => ({ xp: 0, messages: 0, coins: 0, lastXpAt: 0, lastDailyAt: 0, streak: 0, inventory: {}, achievements: [] });

/**
 * First round of a single-elimination bracket for 2-32 players: shuffled
 * fairly (crypto), padded to a power of two, byes go through automatically.
 */
function buildBracket(players, randomInt = crypto.randomInt) {
    const list = [...new Set(players)];
    if (list.length < 2 || list.length > 32) throw new Error('A bracket needs 2 to 32 players.');
    for (let i = list.length - 1; i > 0; i -= 1) {
        const j = randomInt(i + 1);
        [list[i], list[j]] = [list[j], list[i]];
    }
    let size = 2;
    while (size < list.length) size *= 2;
    const seeded = [...list, ...Array(size - list.length).fill(null)];
    const matches = [];
    for (let i = 0; i < size / 2; i += 1) {
        // Byes are spread out: player i meets slot (size-1-i).
        const a = seeded[i];
        const b = seeded[size - 1 - i];
        matches.push({ a, b, winner: b === null ? a : a === null ? b : null });
    }
    return { rounds: [matches], champion: null };
}

/** Records a match result and builds the next round when a round is complete. */
function reportWinner(bracket, winner) {
    const round = bracket.rounds[bracket.rounds.length - 1];
    const match = round.find((m) => m.winner === null && (m.a === winner || m.b === winner));
    if (!match) throw new Error('That player has no open match.');
    match.winner = winner;
    if (round.every((m) => m.winner !== null)) {
        const winners = round.map((m) => m.winner);
        if (winners.length === 1) bracket.champion = winners[0];
        else {
            const next = [];
            for (let i = 0; i < winners.length; i += 2) next.push({ a: winners[i], b: winners[i + 1], winner: null });
            bracket.rounds.push(next);
        }
    }
    return bracket;
}

/** Fair pick of n distinct winners. */
function pickWinners(entrants, n, randomInt = crypto.randomInt) {
    const pool = [...new Set(entrants)];
    const winners = [];
    while (winners.length < n && pool.length) winners.push(pool.splice(randomInt(pool.length), 1)[0]);
    return winners;
}

const TRIVIA = Object.freeze([
    ['How many players are on the field for one football (soccer) team?', ['11', '9', '10', '12']],
    ['What is the largest planet in our solar system?', ['Jupiter', 'Saturn', 'Neptune', 'Earth']],
    ['Which gas do plants absorb from the air?', ['Carbon dioxide', 'Oxygen', 'Nitrogen', 'Helium']],
    ['How many sides does a hexagon have?', ['6', '5', '7', '8']],
    ['What is the capital of Japan?', ['Tokyo', 'Osaka', 'Kyoto', 'Seoul']],
    ['Which planet is known as the Red Planet?', ['Mars', 'Venus', 'Mercury', 'Jupiter']],
    ['What is the boiling point of water at sea level in °C?', ['100', '90', '80', '120']],
    ['Which ocean is the largest?', ['Pacific', 'Atlantic', 'Indian', 'Arctic']],
    ['How many continents are there?', ['7', '5', '6', '8']],
    ['Who painted the Mona Lisa?', ['Leonardo da Vinci', 'Michelangelo', 'Raphael', 'Van Gogh']],
    ['What is the chemical symbol for gold?', ['Au', 'Ag', 'Gd', 'Go']],
    ['How many minutes are in a day?', ['1440', '1200', '1600', '1240']],
    ['Which animal is the largest mammal?', ['Blue whale', 'Elephant', 'Giraffe', 'Orca']],
    ['What is the square root of 144?', ['12', '14', '11', '13']],
    ['Which language has the most native speakers?', ['Mandarin Chinese', 'English', 'Spanish', 'Hindi']],
    ['In which year did the first person walk on the Moon?', ['1969', '1972', '1965', '1959']],
    ['What is the hardest natural substance?', ['Diamond', 'Iron', 'Quartz', 'Granite']],
    ['How many bones are in the adult human body?', ['206', '201', '212', '196']],
    ['Which country is home to the Taj Mahal?', ['India', 'Pakistan', 'Iran', 'Nepal']],
    ['What is the freezing point of water in °F?', ['32', '0', '10', '-4']],
    ['Which is the smallest prime number?', ['2', '1', '3', '0']],
    ['What colour do you get by mixing blue and yellow?', ['Green', 'Purple', 'Orange', 'Brown']],
    ['How many strings does a standard guitar have?', ['6', '4', '5', '7']],
    ['Which planet has the most visible rings?', ['Saturn', 'Uranus', 'Jupiter', 'Mars']],
    ['What does CPU stand for?', ['Central Processing Unit', 'Computer Power Unit', 'Core Program Utility', 'Central Program Unit']]
].map(([question, answers]) => Object.freeze({ question, correct: answers[0], answers })));

/** A trivia round: the question with its answers shuffled. */
function triviaRound(randomInt = crypto.randomInt) {
    const q = TRIVIA[randomInt(TRIVIA.length)];
    const answers = [...q.answers];
    for (let i = answers.length - 1; i > 0; i -= 1) {
        const j = randomInt(i + 1);
        [answers[i], answers[j]] = [answers[j], answers[i]];
    }
    return { question: q.question, answers, correctIndex: answers.indexOf(q.correct) };
}

const RPS = Object.freeze(['rock', 'paper', 'scissors']);
/** 'win' | 'lose' | 'draw' for the player. */
function rpsResult(player, bot) {
    if (player === bot) return 'draw';
    return (player === 'rock' && bot === 'scissors') || (player === 'paper' && bot === 'rock') || (player === 'scissors' && bot === 'paper') ? 'win' : 'lose';
}

module.exports = {
    XP_MIN, XP_MAX, XP_COOLDOWN_MS, DAILY_MS, STREAK_GRACE_MS, COIN_CAP, ACHIEVEMENTS, TRIVIA, RPS,
    xpForLevel, levelFromXp, rollXp, newAchievements, blankMember, buildBracket, reportWinner, pickWinners, triviaRound, rpsResult
};
