const { execFile } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function commandArgs(template, inputPath, outputPath) {
    return template.map((value) => value.replaceAll('{input}', inputPath).replaceAll('{output}', outputPath));
}

function runCommand(command, args, timeout = 60_000) {
    return new Promise((resolve, reject) => {
        execFile(command, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) reject(new Error(stderr.trim() || error.message));
            else resolve(stdout.trim());
        });
    });
}

async function transcribeWav(settings, wavPath) {
    if (!settings.sttCommand) throw new Error('STT_COMMAND is not configured.');
    const output = await runCommand(settings.sttCommand, commandArgs(settings.sttArgs, wavPath, ''), settings.sttTimeoutMs);
    return output.trim();
}

async function synthesizeSpeech(settings, text) {
    if (!settings.ttsCommand) throw new Error('TTS_COMMAND is not configured.');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zigbot-tts-'));
    const outputPath = path.join(directory, 'response.wav');
    await runCommand(settings.ttsCommand, commandArgs(settings.ttsArgs, '', outputPath).map((value) => value.replace('{text}', text)), settings.ttsTimeoutMs);
    return { outputPath, directory };
}

async function removeTemporaryDirectory(directory) {
    await fs.rm(directory, { recursive: true, force: true });
}

module.exports = { transcribeWav, synthesizeSpeech, removeTemporaryDirectory };
