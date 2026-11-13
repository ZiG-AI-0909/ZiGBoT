/**
 * discord.py 2 project generator (Python 3.10+, app commands).
 * Pure: returns { path: content } and never runs anything.
 *
 * Layout: bot.py (entry), config.py, settings.json, commands/<name>.py
 * (each defines setup(tree, bot)), events/<name>.py (each defines
 * setup(bot)), tests/test_commands.py (unittest).
 */
const shared = require('./shared');

const COMMANDS = {
    ping: `import discord
from discord import app_commands


def setup(tree: app_commands.CommandTree, bot: discord.Client) -> None:
    @tree.command(name="ping", description="Check that the bot is alive")
    async def ping(interaction: discord.Interaction) -> None:
        await interaction.response.send_message(f"Pong! {round(bot.latency * 1000)} ms", ephemeral=True)
`,
    kick: `import discord
from discord import app_commands

from util.hierarchy import outranks


def setup(tree: app_commands.CommandTree, bot: discord.Client) -> None:
    @tree.command(name="kick", description="Kick a member")
    @app_commands.default_permissions(kick_members=True)
    @app_commands.guild_only()
    async def kick(interaction: discord.Interaction, member: discord.Member, reason: str = "No reason given") -> None:
        if not outranks(interaction.user, member) or not interaction.guild.me.top_role > member.top_role:
            await interaction.response.send_message("I cannot kick that member (role hierarchy or permissions).", ephemeral=True)
            return
        await member.kick(reason=reason[:400])
        await interaction.response.send_message(f"Kicked {member}.", ephemeral=True)
`,
    ban: `import discord
from discord import app_commands

from util.hierarchy import outranks


def setup(tree: app_commands.CommandTree, bot: discord.Client) -> None:
    @tree.command(name="ban", description="Ban a member")
    @app_commands.default_permissions(ban_members=True)
    @app_commands.guild_only()
    async def ban(interaction: discord.Interaction, member: discord.Member, reason: str = "No reason given") -> None:
        if not outranks(interaction.user, member) or not interaction.guild.me.top_role > member.top_role:
            await interaction.response.send_message("I cannot ban that member (role hierarchy or permissions).", ephemeral=True)
            return
        await member.ban(reason=reason[:400])
        await interaction.response.send_message(f"Banned {member}.", ephemeral=True)
`,
    timeout: `from datetime import timedelta

import discord
from discord import app_commands

from util.hierarchy import outranks


def setup(tree: app_commands.CommandTree, bot: discord.Client) -> None:
    @tree.command(name="timeout", description="Time out a member")
    @app_commands.default_permissions(moderate_members=True)
    @app_commands.guild_only()
    async def timeout(interaction: discord.Interaction, member: discord.Member, minutes: app_commands.Range[int, 1, 40320], reason: str = "No reason given") -> None:
        if not outranks(interaction.user, member) or not interaction.guild.me.top_role > member.top_role:
            await interaction.response.send_message("I cannot time out that member (role hierarchy or permissions).", ephemeral=True)
            return
        await member.timeout(timedelta(minutes=minutes), reason=reason[:400])
        await interaction.response.send_message(f"Timed out {member} for {minutes} minute(s).", ephemeral=True)
`,
    purge: `import discord
from discord import app_commands


def setup(tree: app_commands.CommandTree, bot: discord.Client) -> None:
    @tree.command(name="purge", description="Delete recent messages in this channel")
    @app_commands.default_permissions(manage_messages=True)
    @app_commands.guild_only()
    async def purge(interaction: discord.Interaction, count: app_commands.Range[int, 1, 100]) -> None:
        await interaction.response.defer(ephemeral=True)
        deleted = await interaction.channel.purge(limit=count)
        await interaction.followup.send(f"Deleted {len(deleted)} message(s).", ephemeral=True)
`,
    poll: `import discord
from discord import app_commands

from config import SETTINGS, embed_colour

NUMBERS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"]


def setup(tree: app_commands.CommandTree, bot: discord.Client) -> None:
    @tree.command(name="poll", description="Start a quick poll")
    async def poll(interaction: discord.Interaction, question: str, options: str) -> None:
        choices = [o.strip() for o in options.split("|") if o.strip()][:5]
        if len(choices) < 2:
            await interaction.response.send_message("Give at least two options, separated by |.", ephemeral=True)
            return
        embed = discord.Embed(title=question[:200], description="\\n".join(f"{NUMBERS[i]} {c}" for i, c in enumerate(choices)), colour=embed_colour())
        await interaction.response.send_message(embed=embed, allowed_mentions=discord.AllowedMentions.none())
        message = await interaction.original_response()
        for i in range(len(choices)):
            await message.add_reaction(NUMBERS[i])
`,
    serverinfo: `import discord
from discord import app_commands

from config import embed_colour


def setup(tree: app_commands.CommandTree, bot: discord.Client) -> None:
    @tree.command(name="serverinfo", description="About this server")
    @app_commands.guild_only()
    async def serverinfo(interaction: discord.Interaction) -> None:
        guild = interaction.guild
        embed = discord.Embed(title=guild.name, colour=embed_colour())
        embed.add_field(name="Members", value=str(guild.member_count))
        embed.add_field(name="Created", value=discord.utils.format_dt(guild.created_at, "D"))
        await interaction.response.send_message(embed=embed)
`,
    ask: `import aiohttp
import discord
from discord import app_commands

import config


def setup(tree: app_commands.CommandTree, bot: discord.Client) -> None:
    @tree.command(name="ask", description="Ask the AI assistant")
    async def ask(interaction: discord.Interaction, question: str) -> None:
        if not config.AI_API_KEY:
            await interaction.response.send_message("The AI is not configured (AI_API_KEY).", ephemeral=True)
            return
        await interaction.response.defer()
        answer = "The AI did not answer. Try again later."
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as session:
                async with session.post(
                    f"{config.AI_BASE_URL}/chat/completions",
                    headers={"Authorization": f"Bearer {config.AI_API_KEY}"},
                    json={
                        "model": config.AI_MODEL,
                        "max_tokens": 500,
                        "messages": [
                            {"role": "system", "content": "You are a helpful Discord assistant. Keep answers short."},
                            {"role": "user", "content": question[:1000]},
                        ],
                    },
                ) as response:
                    if response.status == 200:
                        data = await response.json()
                        answer = str(data["choices"][0]["message"]["content"])
        except (aiohttp.ClientError, KeyError, IndexError, TimeoutError):
            pass
        await interaction.followup.send(answer[:1900], allowed_mentions=discord.AllowedMentions.none())
`,
    ticketpanel: `import discord
from discord import app_commands

from config import embed_colour


class TicketPanel(discord.ui.View):
    def __init__(self) -> None:
        super().__init__(timeout=None)
        self.add_item(discord.ui.Button(label="Open ticket", style=discord.ButtonStyle.primary, custom_id="ticket:open"))


def setup(tree: app_commands.CommandTree, bot: discord.Client) -> None:
    @tree.command(name="ticketpanel", description='Post the "open a ticket" button here')
    @app_commands.default_permissions(manage_guild=True)
    @app_commands.guild_only()
    async def ticketpanel(interaction: discord.Interaction) -> None:
        embed = discord.Embed(title="Need help?", description="Press the button to open a private ticket.", colour=embed_colour())
        await interaction.channel.send(embed=embed, view=TicketPanel())
        await interaction.response.send_message("Ticket panel posted.", ephemeral=True)
`,
    close: `import asyncio

import discord
from discord import app_commands


def setup(tree: app_commands.CommandTree, bot: discord.Client) -> None:
    @tree.command(name="close", description="Close this ticket")
    @app_commands.guild_only()
    async def close(interaction: discord.Interaction) -> None:
        if not interaction.channel.name.startswith("ticket-"):
            await interaction.response.send_message("This is not a ticket channel.", ephemeral=True)
            return
        await interaction.response.send_message("Closing this ticket in 5 seconds.")
        await asyncio.sleep(5)
        await interaction.channel.delete(reason="Ticket closed")
`
};

function files(project) {
    const t = shared.templateParts(project.template);
    const out = {};
    for (const name of t.commands) out[`commands/${name}.py`] = COMMANDS[name];
    out['commands/__init__.py'] = `"""Slash commands: each module defines setup(tree, bot)."""
NAMES = [${t.commands.map((c) => `"${c}"`).join(', ')}]
`;
    if (t.commands.some((c) => ['kick', 'ban', 'timeout'].includes(c))) {
        out['util/__init__.py'] = '';
        out['util/hierarchy.py'] = `import discord


def outranks(moderator: discord.Member, target: discord.Member) -> bool:
    """Discord's rule for the person asking: only the owner may act on members at or above their own top role."""
    if moderator.guild.owner_id == moderator.id:
        return True
    return moderator.top_role > target.top_role
`;
    }
    out['events/__init__.py'] = '"""Events: each module defines setup(bot)."""\n';
    out['events/errors.py'] = `import logging

import discord
from discord import app_commands

from config import SETTINGS

log = logging.getLogger("bot")


def setup(bot: discord.Client) -> None:
    @bot.tree.error
    async def on_app_command_error(interaction: discord.Interaction, error: app_commands.AppCommandError) -> None:
        log.exception("command error", exc_info=error)
        message = SETTINGS["messages"]["error"]
        if interaction.response.is_done():
            await interaction.followup.send(message, ephemeral=True)
        else:
            await interaction.response.send_message(message, ephemeral=True)
`;
    if (t.welcome) {
        out['events/members.py'] = `import discord

import config
from config import SETTINGS


def setup(bot: discord.Client) -> None:
    @bot.event
    async def on_member_join(member: discord.Member) -> None:
        if not config.WELCOME_CHANNEL_ID or member.bot:
            return
        channel = member.guild.get_channel(int(config.WELCOME_CHANNEL_ID))
        if channel is None:
            return
        text = SETTINGS["messages"]["welcome"].replace("{user}", member.mention).replace("{server}", member.guild.name)
        await channel.send(text, allowed_mentions=discord.AllowedMentions(users=[member], everyone=False, roles=False))

    @bot.event
    async def on_member_remove(member: discord.Member) -> None:
        if not config.WELCOME_CHANNEL_ID or member.bot:
            return
        channel = member.guild.get_channel(int(config.WELCOME_CHANNEL_ID))
        if channel is None:
            return
        text = SETTINGS["messages"]["goodbye"].replace("{user}", member.name).replace("{server}", member.guild.name)
        await channel.send(text, allowed_mentions=discord.AllowedMentions.none())
`;
    }
    if (t.ticketButton) {
        out['events/tickets.py'] = `import discord

import config


def setup(bot: discord.Client) -> None:
    @bot.event
    async def on_interaction(interaction: discord.Interaction) -> None:
        if interaction.type != discord.InteractionType.component or (interaction.data or {}).get("custom_id") != "ticket:open":
            return
        guild = interaction.guild
        name = "".join(ch for ch in f"ticket-{interaction.user.name}".lower() if ch.isalnum() or ch == "-")[:90]
        existing = discord.utils.get(guild.text_channels, name=name)
        if existing:
            await interaction.response.send_message(f"You already have a ticket: {existing.mention}", ephemeral=True)
            return
        overwrites = {
            guild.default_role: discord.PermissionOverwrite(view_channel=False),
            interaction.user: discord.PermissionOverwrite(view_channel=True, send_messages=True, read_message_history=True),
            guild.me: discord.PermissionOverwrite(view_channel=True, send_messages=True, manage_channels=True),
        }
        if config.TICKET_STAFF_ROLE_ID:
            role = guild.get_role(int(config.TICKET_STAFF_ROLE_ID))
            if role:
                overwrites[role] = discord.PermissionOverwrite(view_channel=True, send_messages=True)
        category = guild.get_channel(int(config.TICKET_CATEGORY_ID)) if config.TICKET_CATEGORY_ID else None
        channel = await guild.create_text_channel(name, overwrites=overwrites, category=category)
        await channel.send(f"Hi {interaction.user.mention}, describe your problem and the staff will answer. Use /close when you are done.")
        await interaction.response.send_message(f"Your ticket: {channel.mention}", ephemeral=True)
`;
    }
    out['settings.json'] = shared.settingsJson(project);
    const intentLines = t.intents.includes('GuildMembers') ? '\nintents.members = True  # Privileged: switch on "Server Members" in the Developer Portal' : '';
    out['config.py'] = `"""Secrets and ids come from the environment (.env), never from the code."""
import json
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

SETTINGS = json.loads((Path(__file__).parent / "settings.json").read_text(encoding="utf-8"))


def required(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"Missing {name}: copy .env.example to .env and fill it in.")
    return value


DISCORD_TOKEN = os.environ.get("DISCORD_TOKEN", "")
DISCORD_GUILD_ID = os.environ.get("DISCORD_GUILD_ID", "")
${t.env.map((e) => `${e.name} = os.environ.get("${e.name}", ${JSON.stringify(e.default || '')})`).join('\n')}


def embed_colour() -> int:
    return int(str(SETTINGS["embedColor"]).lstrip("#"), 16)
`;
    out['bot.py'] = `"""${project.botName}: entry point. Run: python bot.py"""
import importlib
import logging

import discord
from discord import app_commands

import commands
import config
from config import SETTINGS

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("bot")

intents = discord.Intents.default()${intentLines}

STATUSES = {"online": discord.Status.online, "idle": discord.Status.idle, "dnd": discord.Status.dnd, "invisible": discord.Status.invisible}
ACTIVITIES = {"Playing": discord.ActivityType.playing, "Listening": discord.ActivityType.listening, "Watching": discord.ActivityType.watching, "Competing": discord.ActivityType.competing}


class Bot(discord.Client):
    def __init__(self) -> None:
        super().__init__(intents=intents)
        self.tree = app_commands.CommandTree(self)

    async def setup_hook(self) -> None:
        for name in commands.NAMES:
            if name in SETTINGS["disabledCommands"]:
                continue
            importlib.import_module(f"commands.{name}").setup(self.tree, self)
        for name in [${['errors', ...(t.welcome ? ['members'] : []), ...(t.ticketButton ? ['tickets'] : [])].map((e) => `"${e}"`).join(', ')}]:
            importlib.import_module(f"events.{name}").setup(self)
        # With DISCORD_GUILD_ID the commands appear in that server at once (testing).
        if config.DISCORD_GUILD_ID:
            guild = discord.Object(id=int(config.DISCORD_GUILD_ID))
            self.tree.copy_global_to(guild=guild)
            await self.tree.sync(guild=guild)
        else:
            await self.tree.sync()

    async def on_ready(self) -> None:
        presence = SETTINGS["presence"]
        activity = discord.Activity(type=ACTIVITIES.get(presence["activityType"], discord.ActivityType.playing), name=presence["activityText"]) if presence["activityText"] else None
        await self.change_presence(status=STATUSES.get(presence["status"], discord.Status.online), activity=activity)
        log.info("Ready as %s in %d server(s).", self.user, len(self.guilds))


if __name__ == "__main__":
    Bot().run(config.required("DISCORD_TOKEN"), log_handler=None)
`;
    out['tests/__init__.py'] = '';
    out['tests/test_commands.py'] = `"""Every command module exists and defines setup(tree, bot). Run: python -m unittest"""
import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class CommandModules(unittest.TestCase):
    def test_every_command_defines_setup(self) -> None:
        names = ast.literal_eval((ROOT / "commands" / "__init__.py").read_text(encoding="utf-8").split("NAMES = ", 1)[1].strip())
        self.assertTrue(names)
        for name in names:
            tree = ast.parse((ROOT / "commands" / f"{name}.py").read_text(encoding="utf-8"))
            functions = {node.name for node in tree.body if isinstance(node, ast.FunctionDef)}
            self.assertIn("setup", functions, name)


if __name__ == "__main__":
    unittest.main()
`;
    out['requirements.txt'] = `discord.py>=2.4,<3\npython-dotenv>=1.0\n${t.commands.includes('ask') ? 'aiohttp>=3.9\n' : ''}`;
    Object.assign(out, shared.commonFiles(project, t, { install: 'pip install -r requirements.txt', register: 'python bot.py (commands sync on start)', start: 'python bot.py', test: 'python -m unittest', ignore: ['__pycache__/', '.venv/'] }));
    return out;
}

module.exports = { files, COMMANDS };
