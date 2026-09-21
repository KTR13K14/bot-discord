require('dotenv').config();

const fs = require('fs');
const path = require('path');

const {
    Client,
    GatewayIntentBits,
    REST,
    Routes,
    SlashCommandBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    MessageFlags,
    PermissionFlagsBits,
    EmbedBuilder,
    ChannelType,
    version: discordJsVersion
} = require('discord.js');

const {
    joinVoiceChannel,
    getVoiceConnection
} = require('@discordjs/voice');

const OpenAI = require('openai');

// ==================================================
// CLIENT
// ==================================================

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// ==================================================
// OPENAI
// ==================================================

const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// ==================================================
// CONFIG
// ==================================================

const GUILD_ID = '1547964026854580235';

const VOICE_CHANNEL_ID = '1547964030105161753';

const GENERAL_CHANNEL_ID = '1547964030105161752';

const COUNT_CHANNEL_ID = '1551661714129428630';

const STEAM_CHANNEL_ID = '1548402848302243922';

const PANEL_CHANNEL_ID = '1548642071290839140';

const AI_CHANNEL_ID = '1551633371787038840';
const AI_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes sans nouveau message

let activeAIChannelId = AI_CHANNEL_ID;
let aiInactivityTimer = null;
const aiChannelTimers = new Map();

// ==================================================
// HISTORIQUE IA
// ==================================================

const aiHistory = new Map();

const MAX_HISTORY = 12;

function getHistory(channelId) {
    if (!aiHistory.has(channelId)) {
        aiHistory.set(channelId, []);
    }

    return aiHistory.get(channelId);
}

function addHistory(channelId, role, content) {
    const history = getHistory(channelId);

    history.push({
        role,
        content
    });

    while (history.length > MAX_HISTORY) {
        history.shift();
    }
}

// ==================================================
// GESTION DU SALON IA
// ==================================================

function clearAIInactivityTimer(channelId = activeAIChannelId) {
    if (channelId === activeAIChannelId && aiInactivityTimer) {
        clearTimeout(aiInactivityTimer);
        aiInactivityTimer = null;
    }

    const timer = aiChannelTimers.get(channelId);
    if (timer) {
        clearTimeout(timer);
        aiChannelTimers.delete(channelId);
    }
}

function resetAIInactivityTimer(channelId = activeAIChannelId) {
    clearAIInactivityTimer(channelId);

    // Le salon IA automatique (#ia) est recréé après 2 minutes.
    if (channelId === activeAIChannelId) {
        aiInactivityTimer = setTimeout(
            async () => {
                await closeAndRecreateAIChannel();
            },
            AI_TIMEOUT_MS
        );
        return;
    }

    // Dans les autres salons, on efface seulement l'historique.
    // Le bot ne supprimera jamais un salon qui n'est pas son #ia automatique.
    const timer = setTimeout(
        () => {
            aiHistory.delete(channelId);
            aiChannelTimers.delete(channelId);
            console.log(`🧠 Historique IA effacé pour le salon ${channelId} après 2 minutes.`);
        },
        AI_TIMEOUT_MS
    );

    aiChannelTimers.set(channelId, timer);
}

async function findOrCreateAIChannel(guild) {
    let channel = guild.channels.cache.get(activeAIChannelId);

    if (
        channel &&
        channel.type === ChannelType.GuildText
    ) {
        return channel;
    }

    channel = guild.channels.cache.find(
        channel =>
            channel.type === ChannelType.GuildText &&
            channel.name === 'ia'
    );

    if (channel) {
        activeAIChannelId = channel.id;
        return channel;
    }

    channel = await guild.channels.create({
        name: 'ia',
        type: ChannelType.GuildText,
        reason: 'Création du salon IA'
    });

    activeAIChannelId = channel.id;

    await channel.send(
        '🤖 **Nouveau salon IA prêt !**\n' +
        'Utilisez `/ia question:` pour poser vos questions.'
    );

    return channel;
}

async function closeAndRecreateAIChannel() {
    clearAIInactivityTimer();

    const oldChannelId = activeAIChannelId;

    try {
        const oldChannel =
            await client.channels.fetch(oldChannelId).catch(() => null);

        const guild =
            client.guilds.cache.get(GUILD_ID);

        if (!guild) {
            console.error('❌ Serveur introuvable pour recréer le salon IA.');
            return;
        }

        let permissionOverwrites;

        if (
            oldChannel &&
            oldChannel.permissionOverwrites?.cache
        ) {
            permissionOverwrites =
                [...oldChannel.permissionOverwrites.cache.values()]
                    .map(overwrite => overwrite.toJSON());
        }

        const newChannel =
            await guild.channels.create({
                name: 'ia',
                type: ChannelType.GuildText,
                parent:
                    oldChannel?.parentId ??
                    undefined,
                permissionOverwrites,
                reason:
                    'Nouvelle conversation IA après 2 minutes sans question'
            });

        activeAIChannelId = newChannel.id;

        // L'ancien historique est définitivement oublié.
        aiHistory.delete(oldChannelId);

        await newChannel.send({
            content:
                '@everyone\n\n' +
                '🔒 **Conversation terminée.**\n' +
                'Aucune nouvelle question n’a été posée pendant **2 minutes**.\n\n' +
                '🧠 L’historique de la conversation précédente a été supprimé.\n\n' +
                '🤖 **Une nouvelle conversation est maintenant ouverte !**\n' +
                'Utilisez `/ia question:` pour commencer.',
            allowedMentions: {
                parse: ['everyone']
            }
        });

        if (
            oldChannel &&
            typeof oldChannel.delete === 'function' &&
            oldChannel.deletable
        ) {
            await oldChannel.delete(
                'Conversation IA terminée après 2 minutes sans nouveau message'
            );
        }

        console.log(
            `🤖 Salon IA renouvelé : ${newChannel.id}`
        );

        // Le chrono repartira à la prochaine question.
        aiInactivityTimer = null;

    } catch (error) {
        console.error(
            '❌ Impossible de recréer le salon IA :',
            error
        );

        aiHistory.delete(oldChannelId);
        aiInactivityTimer = null;
    }
}

// ==================================================
// COMPTEUR
// ==================================================

const COUNTER_FILE = path.join(
    __dirname,
    'counter.json'
);

let count = 1;
let counting = false;
let countInterval = null;

if (fs.existsSync(COUNTER_FILE)) {
    try {
        const saved = JSON.parse(
            fs.readFileSync(
                COUNTER_FILE,
                'utf8'
            )
        );

        if (
            Number.isInteger(saved.count) &&
            saved.count >= 1
        ) {
            count = saved.count;
        }
    } catch {
        console.log(
            '⚠️ counter.json illisible.'
        );
    }
}

function saveCounter() {
    fs.writeFileSync(
        COUNTER_FILE,
        JSON.stringify(
            { count },
            null,
            2
        ),
        'utf8'
    );
}

function stopCounter() {
    counting = false;

    if (countInterval) {
        clearInterval(countInterval);
        countInterval = null;
    }

    saveCounter();
}

async function startCounter() {
    if (counting) {
        return false;
    }

    const channel =
        await client.channels.fetch(
            COUNT_CHANNEL_ID
        );

    if (
        !channel ||
        !channel.isTextBased()
    ) {
        throw new Error(
            'Salon compteur introuvable.'
        );
    }

    counting = true;

    await channel.send(
        String(count)
    );

    count++;
    saveCounter();

    countInterval = setInterval(
        async () => {
            if (!counting) {
                return;
            }

            try {
                await channel.send(
                    String(count)
                );

                count++;
                saveCounter();

            } catch (error) {
                console.error(
                    '❌ Erreur compteur :',
                    error
                );

                stopCounter();
            }
        },
        2000
    );

    return true;
}

// ==================================================
// VOCAL
// ==================================================

function connectToVoice(channel) {
    return joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator:
            channel.guild.voiceAdapterCreator,
        selfMute: true,
        selfDeaf: true
    });
}

// ==================================================
// STEAM
// ==================================================

async function searchSteamGame(gameName) {
    const url =
        'https://store.steampowered.com/api/storesearch/' +
        `?term=${encodeURIComponent(gameName)}` +
        '&cc=fr&l=french';

    const response =
        await fetch(url);

    if (!response.ok) {
        throw new Error(
            `Steam HTTP ${response.status}`
        );
    }

    const data =
        await response.json();

    return data.items?.slice(
        0,
        5
    ) ?? [];
}

// ==================================================
// IA
// ==================================================

async function askAI(
    channelId,
    question,
    userName,
    imageUrls = []
) {
    const history =
        getHistory(channelId);

    const systemPrompt = `
Tu es KTR.BOT, un assistant IA intégré à Discord.

Tu réponds en français sauf si l'utilisateur demande une autre langue.

Tu aides notamment pour :
- programmation JavaScript / Node.js / Python
- création et modification de bots Discord
- dépannage d'erreurs
- explications techniques
- idées de projets
- jeux vidéo
- questions générales

Tu peux analyser les images envoyées par l'utilisateur.
Quand une image est fournie :
- regarde attentivement son contenu
- décris ce qui est réellement visible
- lis le texte visible quand c'est possible
- utilise l'image pour répondre à la question de l'utilisateur
- ne prétends pas voir quelque chose qui n'est pas clairement visible

Quand tu fournis du code :
- donne du code complet quand c'est pertinent
- explique exactement où le mettre
- évite de supprimer des fonctionnalités existantes sans raison
- signale les erreurs probables
- privilégie les solutions simples et fonctionnelles

Sois utile, direct et clair.
Tu peux utiliser des emojis avec modération.

Nom Discord de l'utilisateur : ${userName}
`;

    const currentContent = [];

    if (question?.trim()) {
        currentContent.push({
            type: 'input_text',
            text: question
        });
    }

    for (const imageUrl of imageUrls.slice(0, 5)) {
        currentContent.push({
            type: 'input_image',
            image_url: imageUrl,
            detail: 'auto'
        });
    }

    const input = [
        {
            role: 'system',
            content: systemPrompt
        },
        ...history,
        {
            role: 'user',
            content: currentContent.length === 1 &&
                currentContent[0].type === 'input_text'
                ? currentContent[0].text
                : currentContent
        }
    ];

    const response =
        await openai.responses.create({
            model: 'gpt-5.6-luna',
            input
        });

    const answer =
        response.output_text?.trim();

    if (!answer) {
        throw new Error(
            'Réponse IA vide.'
        );
    }

    const historyContent =
        imageUrls.length > 0
            ? currentContent
            : question;

    addHistory(
        channelId,
        'user',
        historyContent
    );

    addHistory(
        channelId,
        'assistant',
        answer
    );

    return answer;
}

// ==================================================
// PANNEAU
// ==================================================

function createPanel() {
    const embed =
        new EmbedBuilder()
            .setTitle(
                '⚡ KTR.BOT — RESSOURCES'
            )
            .setDescription(
                'Bienvenue 👋\n\n' +
                'Choisis une ressource dans le menu ci-dessous.\n\n' +
                '🎵 Spotify / Spicetify\n' +
                '🧩 Plugins Steam\n' +
                '⚡ Project Lightning\n' +
                '🎮 Steam'
            )
            .setColor(0x5865F2)
            .setFooter({
                text:
                    'KTR.BOT • Ressources'
            });

    const menu =
        new StringSelectMenuBuilder()
            .setCustomId(
                'resource_menu'
            )
            .setPlaceholder(
                'Sélectionnez une option...'
            )
            .addOptions(
                {
                    label:
                        'Spotify / Spicetify',
                    description:
                        'Ouvrir Spicetify',
                    value:
                        'spotify',
                    emoji:
                        '🎵'
                },
                {
                    label:
                        'Plugins Steam',
                    description:
                        'Ouvrir SteamBrew',
                    value:
                        'plugins',
                    emoji:
                        '🧩'
                },
                {
                    label:
                        'Project Lightning',
                    description:
                        'Ouvrir Project Lightning',
                    value:
                        'lightning',
                    emoji:
                        '⚡'
                },
                {
                    label:
                        'Steam',
                    description:
                        'Ouvrir Steam',
                    value:
                        'steam',
                    emoji:
                        '🎮'
                }
            );

    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder()
                .addComponents(menu)
        ]
    };
}

// ==================================================
// UPTIME
// ==================================================

function formatUptime(ms) {
    let seconds =
        Math.floor(ms / 1000);

    const days =
        Math.floor(
            seconds / 86400
        );

    seconds %= 86400;

    const hours =
        Math.floor(
            seconds / 3600
        );

    seconds %= 3600;

    const minutes =
        Math.floor(
            seconds / 60
        );

    seconds %= 60;

    return (
        `${days}j ` +
        `${hours}h ` +
        `${minutes}m ` +
        `${seconds}s`
    );
}

// ==================================================
// COMMANDES
// ==================================================

const commands = [
    new SlashCommandBuilder()
        .setName('help')
        .setDescription(
            'Affiche les commandes'
        ),

    new SlashCommandBuilder()
        .setName('ping')
        .setDescription(
            'Affiche le ping du bot'
        ),

    new SlashCommandBuilder()
        .setName('uptime')
        .setDescription(
            'Affiche depuis combien de temps le bot tourne'
        ),

    new SlashCommandBuilder()
        .setName('avatar')
        .setDescription(
            'Affiche un avatar'
        )
        .addUserOption(
            option =>
                option
                    .setName('membre')
                    .setDescription(
                        'Membre'
                    )
                    .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('userinfo')
        .setDescription(
            'Affiche les informations d’un membre'
        )
        .addUserOption(
            option =>
                option
                    .setName('membre')
                    .setDescription(
                        'Membre'
                    )
                    .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('serverinfo')
        .setDescription(
            'Affiche les informations du serveur'
        ),

    new SlashCommandBuilder()
        .setName('botinfo')
        .setDescription(
            'Affiche les informations du bot'
        ),

    new SlashCommandBuilder()
        .setName('channelinfo')
        .setDescription(
            'Affiche les informations d’un salon'
        )
        .addChannelOption(
            option =>
                option
                    .setName('salon')
                    .setDescription(
                        'Salon'
                    )
                    .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('grosfdp')
        .setDescription(
            'Rejoint le vocal où tu es'
        ),

    new SlashCommandBuilder()
        .setName('rejoin')
        .setDescription(
            'Reconnecte le bot dans ton vocal'
        ),

    new SlashCommandBuilder()
        .setName('fdp')
        .setDescription(
            'Quitte le vocal'
        ),

    new SlashCommandBuilder()
        .setName('parle')
        .setDescription(
            'Envoie un message dans le général'
        ),

    new SlashCommandBuilder()
        .setName('compteur')
        .setDescription(
            'Lance le compteur'
        ),

    new SlashCommandBuilder()
        .setName('stopcompteur')
        .setDescription(
            'Arrête le compteur'
        ),

    new SlashCommandBuilder()
        .setName('steamid')
        .setDescription(
            'Cherche le Steam App ID d’un jeu'
        )
        .addStringOption(
            option =>
                option
                    .setName('jeu')
                    .setDescription(
                        'Nom du jeu'
                    )
                    .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('onlinefix')
        .setDescription(
            'Affiche le lien Project Lightning'
        ),

    new SlashCommandBuilder()
        .setName('spotifyfree')
        .setDescription(
            'Affiche le lien Spicetify'
        ),

    new SlashCommandBuilder()
        .setName('pluginsteam')
        .setDescription(
            'Affiche le lien SteamBrew'
        ),

    new SlashCommandBuilder()
        .setName('panel')
        .setDescription(
            'Envoie le panneau des ressources'
        ),

    new SlashCommandBuilder()
        .setName('ia')
        .setDescription(
            'Pose une question à l’IA'
        )
        .addStringOption(
            option =>
                option
                    .setName('question')
                    .setDescription(
                        'Ta question'
                    )
                    .setRequired(true)
        )
        .addAttachmentOption(
            option =>
                option
                    .setName('image')
                    .setDescription(
                        'Image à analyser (optionnel)'
                    )
                    .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('say')
        .setDescription(
            'Fait parler le bot'
        )
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ManageMessages
        )
        .addStringOption(
            option =>
                option
                    .setName('texte')
                    .setDescription(
                        'Texte à envoyer'
                    )
                    .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('kick')
        .setDescription(
            'Expulse un membre'
        )
        .setDefaultMemberPermissions(
            PermissionFlagsBits.KickMembers
        )
        .addUserOption(
            option =>
                option
                    .setName('membre')
                    .setDescription(
                        'Membre'
                    )
                    .setRequired(true)
        )
        .addStringOption(
            option =>
                option
                    .setName('raison')
                    .setDescription(
                        'Raison'
                    )
                    .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('ban')
        .setDescription(
            'Bannit un membre'
        )
        .setDefaultMemberPermissions(
            PermissionFlagsBits.BanMembers
        )
        .addUserOption(
            option =>
                option
                    .setName('membre')
                    .setDescription(
                        'Membre'
                    )
                    .setRequired(true)
        )
        .addStringOption(
            option =>
                option
                    .setName('raison')
                    .setDescription(
                        'Raison'
                    )
                    .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('timeout')
        .setDescription(
            'Exclut temporairement un membre'
        )
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ModerateMembers
        )
        .addUserOption(
            option =>
                option
                    .setName('membre')
                    .setDescription(
                        'Membre'
                    )
                    .setRequired(true)
        )
        .addIntegerOption(
            option =>
                option
                    .setName('secondes')
                    .setDescription(
                        'Durée'
                    )
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(
                        2419200
                    )
        )
        .addStringOption(
            option =>
                option
                    .setName('raison')
                    .setDescription(
                        'Raison'
                    )
                    .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('untimeout')
        .setDescription(
            'Retire l’exclusion temporaire'
        )
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ModerateMembers
        )
        .addUserOption(
            option =>
                option
                    .setName('membre')
                    .setDescription(
                        'Membre'
                    )
                    .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('8ball')
        .setDescription(
            'Répond à une question'
        )
        .addStringOption(
            option =>
                option
                    .setName('question')
                    .setDescription(
                        'Question'
                    )
                    .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('coinflip')
        .setDescription(
            'Pile ou face'
        ),

    new SlashCommandBuilder()
        .setName('roll')
        .setDescription(
            'Lance un dé'
        )
        .addIntegerOption(
            option =>
                option
                    .setName('max')
                    .setDescription(
                        'Maximum'
                    )
                    .setRequired(false)
                    .setMinValue(2)
                    .setMaxValue(
                        1000000
                    )
        ),

    new SlashCommandBuilder()
        .setName('random')
        .setDescription(
            'Nombre aléatoire'
        )
        .addIntegerOption(
            option =>
                option
                    .setName('min')
                    .setDescription(
                        'Minimum'
                    )
                    .setRequired(true)
        )
        .addIntegerOption(
            option =>
                option
                    .setName('max')
                    .setDescription(
                        'Maximum'
                    )
                    .setRequired(true)
        ),

    ...[
        10,
        20,
        30,
        40,
        50,
        60,
        70,
        80,
        90,
        100
    ].map(
        number =>
            new SlashCommandBuilder()
                .setName(
                    `clear${number}`
                )
                .setDescription(
                    `Supprime ${number} messages`
                )
                .setDefaultMemberPermissions(
                    PermissionFlagsBits.ManageMessages
                )
                .toJSON()
    )
];

// ==================================================
// COMMANDES JSON
// ==================================================

async function registerCommands() {
    const rest =
        new REST({
            version: '10'
        }).setToken(
            process.env.TOKEN
        );

    await rest.put(
        Routes.applicationGuildCommands(
            client.user.id,
            GUILD_ID
        ),
        {
            body: commands
        }
    );

    console.log(
        '✅ Toutes les commandes sont installées.'
    );
}

// ==================================================
// READY
// ==================================================

client.once(
    'clientReady',
    async () => {
        console.log(
            `✅ Connecté : ${client.user.tag}`
        );

        client.user.setPresence({
            activities: [
                {
                    name:
                        'En train de chier 💩',
                    type: 0
                }
            ],
            status: 'dnd'
        });

        console.log(
            '🔴 Statut : Ne pas déranger'
        );

        console.log(
            '💩 Activité : En train de chier'
        );

        await registerCommands();

        const guild =
            client.guilds.cache.get(
                GUILD_ID
            );

        if (!guild) {
            console.log(
                '❌ Serveur introuvable.'
            );
            return;
        }

        const aiChannel =
            await findOrCreateAIChannel(guild);

        console.log(
            `🤖 Salon IA actif : #${aiChannel.name} (${aiChannel.id})`
        );

        const voiceChannel =
            guild.channels.cache.get(
                VOICE_CHANNEL_ID
            );

        if (
            voiceChannel &&
            voiceChannel.isVoiceBased()
        ) {
            connectToVoice(
                voiceChannel
            );

            console.log(
                `🔊 Connecté à ${voiceChannel.name}`
            );
        } else {
            console.log(
                '❌ Vocal introuvable.'
            );
        }

        console.log(
            `🔢 Compteur sauvegardé : ${count}`
        );

        if (!process.env.OPENAI_API_KEY) {
            console.log(
                '⚠️ OPENAI_API_KEY absent : /ia ne fonctionnera pas.'
            );
        } else {
            console.log(
                '🤖 IA activée.'
            );
        }
    }
);

// ==================================================
// INTERACTIONS
// ==================================================

// ==================================================
// CONVERSATION IA SANS /ia À CHAQUE MESSAGE
// ==================================================
// /ia peut être utilisé dans N'IMPORTE QUEL salon texte.
// Une fois /ia lancé dans un salon, les messages normaux de ce salon
// continuent la même conversation pendant 2 minutes d'inactivité maximum.
client.on(
    'messageCreate',
    async message => {

        if (
            message.author.bot ||
            !message.guild ||
            !message.content ||
            message.content.startsWith('/')
        ) {
            return;
        }

        const channelId = message.channelId;
        const history = aiHistory.get(channelId);

        // Il faut d'abord lancer /ia dans ce salon.
        if (!history || history.length === 0) {
            return;
        }

        if (!process.env.OPENAI_API_KEY) {
            return;
        }

        try {
            await message.channel.sendTyping();

            const imageUrls =
                message.attachments
                    .filter(attachment => {
                        const type =
                            attachment.contentType || '';

                        return (
                            type.startsWith('image/') ||
                            /\.(png|jpe?g|gif|webp|bmp|avif)(\?|$)/i.test(
                                attachment.url
                            )
                        );
                    })
                    .map(attachment => attachment.url)
                    .slice(0, 5);

            // Un message avec une image compte aussi comme activité IA.
            const answer = await askAI(
                channelId,
                message.content || 'Analyse cette image.',
                message.author.username,
                imageUrls
            );

            resetAIInactivityTimer(channelId);

            if (answer.length <= 2000) {
                await message.reply(answer);
            } else {
                const parts = answer.match(/.{1,1900}/gs) || [];

                if (parts[0]) {
                    await message.reply(parts[0]);
                }

                for (const part of parts.slice(1)) {
                    await message.channel.send(part);
                }
            }
        } catch (error) {
            console.error('❌ Erreur IA message normal :', error);
            await message.reply(
                '❌ Une erreur est survenue avec l’IA.'
            ).catch(() => {});
        }
    }
);

client.on(
    'interactionCreate',
    async interaction => {

        try {

            // ==========================================
            // MENU
            // ==========================================

            if (
                interaction.isStringSelectMenu() &&
                interaction.customId ===
                    'resource_menu'
            ) {

                const selected =
                    interaction.values[0];

                const links = {
                    spotify:
                        '🎵 **Spicetify**\nhttps://spicetify.app',

                    plugins:
                        '🧩 **SteamBrew**\nhttps://steambrew.app',

                    lightning:
                        '⚡ **Project Lightning**\nhttps://project-lightning-web.vercel.app',

                    steam:
                        '🎮 **Steam**\nhttps://store.steampowered.com'
                };

                await interaction.reply({
                    content:
                        links[selected],
                    flags:
                        MessageFlags.Ephemeral
                });

                return;
            }

            if (
                !interaction.isChatInputCommand()
            ) {
                return;
            }

            // ==========================================
            // /IA
            // ==========================================

            if (
                interaction.commandName ===
                'ia'
            ) {

                if (!process.env.OPENAI_API_KEY) {
                    await interaction.reply({
                        content:
                            '❌ La clé OpenAI n’est pas configurée dans `.env`.',
                        flags:
                            MessageFlags.Ephemeral
                    });

                    return;
                }

                const question =
                    interaction.options.getString(
                        'question'
                    );

                const image =
                    interaction.options.getAttachment(
                        'image'
                    );

                const imageUrls = image
                    ? [image.url]
                    : [];

                await interaction.deferReply();

                const channelId = interaction.channelId;

                const answer =
                    await askAI(
                        channelId,
                        question,
                        interaction.user.username,
                        imageUrls
                    );

                // Chaque question repousse le délai de 2 minutes pour CE salon.
                resetAIInactivityTimer(channelId);

                // Discord limite les messages à 2000 caractères
                if (answer.length <= 2000) {
                    await interaction.editReply(
                        answer
                    );
                } else {
                    const parts =
                        answer.match(
                            /.{1,1900}/gs
                        ) || [];

                    await interaction.editReply(
                        parts[0]
                    );

                    for (
                        const part of
                        parts.slice(1)
                    ) {
                        await interaction.channel.send(
                            part
                        );
                    }
                }

                return;
            }

            // ==========================================
            // /help
            // ==========================================

            if (
                interaction.commandName ===
                'help'
            ) {

                const embed =
                    new EmbedBuilder()
                        .setTitle(
                            '📚 KTR.BOT — COMMANDES'
                        )
                        .setDescription(
                            '**🤖 IA**\n' +
                            '`/ia question:`\n' +
                            'Le salon est renouvelé après 2 minutes sans nouveau message.\n\n' +

                            '**🔊 Vocal**\n' +
                            '`/grosfdp` `/rejoin` `/fdp`\n\n' +

                            '**🛠️ Modération**\n' +
                            '`/clear10` → `/clear100` `' +
                            '`/kick` `/ban` `/timeout` `/untimeout` `/say`\n\n' +

                            '**📊 Infos**\n' +
                            '`/ping` `/uptime` `/avatar` `' +
                            '`/userinfo` `/serverinfo` `/botinfo` `/channelinfo`\n\n' +

                            '**🎮 Steam / Ressources**\n' +
                            '`/steamid` `/onlinefix` `/spotifyfree` `/pluginsteam` `/panel`\n\n' +

                            '**🔢 Outils**\n' +
                            '`/compteur` `/stopcompteur` `/8ball` `/coinflip` `/roll` `/random`'
                        )
                        .setColor(
                            0x5865F2
                        );

                await interaction.reply({
                    embeds: [
                        embed
                    ]
                });

                return;
            }

            // ==========================================
            // /ping
            // ==========================================

            if (
                interaction.commandName ===
                'ping'
            ) {

                await interaction.reply(
                    `🏓 Pong ! **${client.ws.ping} ms**`
                );

                return;
            }

            // ==========================================
            // /uptime
            // ==========================================

            if (
                interaction.commandName ===
                'uptime'
            ) {

                await interaction.reply(
                    `⏱️ Le bot tourne depuis **${formatUptime(
                        client.uptime || 0
                    )}**.`
                );

                return;
            }

            // ==========================================
            // /avatar
            // ==========================================

            if (
                interaction.commandName ===
                'avatar'
            ) {

                const user =
                    interaction.options.getUser(
                        'membre'
                    ) ||
                    interaction.user;

                const embed =
                    new EmbedBuilder()
                        .setTitle(
                            `🖼️ Avatar de ${user.username}`
                        )
                        .setImage(
                            user.displayAvatarURL({
                                size: 1024,
                                extension:
                                    'png'
                            })
                        )
                        .setColor(
                            0x5865F2
                        );

                await interaction.reply({
                    embeds: [
                        embed
                    ]
                });

                return;
            }

            // ==========================================
            // /userinfo
            // ==========================================

            if (
                interaction.commandName ===
                'userinfo'
            ) {

                const user =
                    interaction.options.getUser(
                        'membre'
                    );

                const member =
                    await interaction.guild
                        .members
                        .fetch(
                            user.id
                        )
                        .catch(
                            () => null
                        );

                const created =
                    Math.floor(
                        user.createdTimestamp /
                        1000
                    );

                const fields = [
                    {
                        name: '🆔 ID',
                        value:
                            `\`${user.id}\``
                    },
                    {
                        name:
                            '👤 Pseudo',
                        value:
                            `\`${user.username}\``
                    },
                    {
                        name:
                            '📛 Nom',
                        value:
                            user.globalName ||
                            'Aucun'
                    },
                    {
                        name:
                            '📅 Création',
                        value:
                            `<t:${created}:F>\n<t:${created}:R>`
                    },
                    {
                        name:
                            '🤖 Type',
                        value:
                            user.bot
                                ? 'Bot'
                                : 'Utilisateur'
                    }
                ];

                if (member) {

                    fields.push({
                        name:
                            '📥 Arrivée',
                        value:
                            member.joinedTimestamp
                                ? `<t:${Math.floor(
                                    member.joinedTimestamp /
                                    1000
                                )}:F>`
                                : 'Inconnue'
                    });
                }

                await interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                '🔎 Informations du membre'
                            )
                            .setThumbnail(
                                user.displayAvatarURL({
                                    size: 256
                                })
                            )
                            .addFields(
                                fields
                            )
                            .setColor(
                                0x5865F2
                            )
                    ]
                });

                return;
            }

            // ==========================================
            // /serverinfo
            // ==========================================

            if (
                interaction.commandName ===
                'serverinfo'
            ) {

                const guild =
                    interaction.guild;

                const embed =
                    new EmbedBuilder()
                        .setTitle(
                            `🏠 ${guild.name}`
                        )
                        .addFields(
                            {
                                name: '🆔 ID',
                                value:
                                    `\`${guild.id}\``
                            },
                            {
                                name:
                                    '👥 Membres',
                                value:
                                    String(
                                        guild.memberCount
                                    )
                            },
                            {
                                name:
                                    '💬 Salons',
                                value:
                                    String(
                                        guild.channels.cache.size
                                    )
                            },
                            {
                                name:
                                    '🚀 Boosts',
                                value:
                                    String(
                                        guild.premiumSubscriptionCount ||
                                        0
                                    )
                            },
                            {
                                name:
                                    '📅 Création',
                                value:
                                    `<t:${Math.floor(
                                        guild.createdTimestamp /
                                        1000
                                    )}:F>`
                            }
                        )
                        .setColor(
                            0x5865F2
                        );

                const icon =
                    guild.iconURL({
                        size: 256
                    });

                if (icon) {
                    embed.setThumbnail(
                        icon
                    );
                }

                await interaction.reply({
                    embeds: [
                        embed
                    ]
                });

                return;
            }

            // ==========================================
            // /botinfo
            // ==========================================

            if (
                interaction.commandName ===
                'botinfo'
            ) {

                await interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                '🤖 KTR.BOT'
                            )
                            .addFields(
                                {
                                    name:
                                        '🏓 Ping',
                                    value:
                                        `${client.ws.ping} ms`
                                },
                                {
                                    name:
                                        '⏱️ Uptime',
                                    value:
                                        formatUptime(
                                            client.uptime ||
                                            0
                                        )
                                },
                                {
                                    name:
                                        '🏠 Serveurs',
                                    value:
                                        String(
                                            client.guilds.cache.size
                                        )
                                },
                                {
                                    name:
                                        '📦 discord.js',
                                    value:
                                        discordJsVersion
                                },
                                {
                                    name:
                                        '🤖 IA',
                                    value:
                                        process.env.OPENAI_API_KEY
                                            ? 'Activée'
                                            : 'Non configurée'
                                }
                            )
                            .setColor(
                                0x5865F2
                            )
                    ]
                });

                return;
            }

            // ==========================================
            // /channelinfo
            // ==========================================

            if (
                interaction.commandName ===
                'channelinfo'
            ) {

                const channel =
                    interaction.options.getChannel(
                        'salon'
                    );

                await interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                `📺 ${channel.name}`
                            )
                            .addFields(
                                {
                                    name:
                                        '🆔 ID',
                                    value:
                                        `\`${channel.id}\``
                                },
                                {
                                    name:
                                        '📁 Type',
                                    value:
                                        String(
                                            channel.type
                                        )
                                }
                            )
                            .setColor(
                                0x5865F2
                            )
                    ]
                });

                return;
            }

            // ==========================================
            // /grosfdp /rejoin
            // ==========================================

            if (
                interaction.commandName ===
                    'grosfdp' ||
                interaction.commandName ===
                    'rejoin'
            ) {

                const member =
                    interaction.member;

                const channel =
                    member?.voice?.channel;

                if (!channel) {
                    await interaction.reply({
                        content:
                            '❌ Tu dois être dans un vocal.',
                        flags:
                            MessageFlags.Ephemeral
                    });

                    return;
                }

                const oldConnection =
                    getVoiceConnection(
                        interaction.guild.id
                    );

                if (oldConnection) {
                    oldConnection.destroy();
                }

                connectToVoice(
                    channel
                );

                await interaction.reply(
                    `✅ Rejoint **${channel.name}** 🔇🎧`
                );

                return;
            }

            // ==========================================
            // /fdp
            // ==========================================

            if (
                interaction.commandName ===
                'fdp'
            ) {

                const connection =
                    getVoiceConnection(
                        interaction.guild.id
                    );

                if (!connection) {
                    await interaction.reply({
                        content:
                            '❌ Je ne suis dans aucun vocal.',
                        flags:
                            MessageFlags.Ephemeral
                    });

                    return;
                }

                connection.destroy();

                await interaction.reply(
                    '👋 J’ai quitté le vocal.'
                );

                return;
            }

            // ==========================================
            // /parle
            // ==========================================

            if (
                interaction.commandName ===
                'parle'
            ) {

                const channel =
                    await client.channels.fetch(
                        GENERAL_CHANNEL_ID
                    );

                if (
                    !channel ||
                    !channel.isTextBased()
                ) {
                    await interaction.reply({
                        content:
                            '❌ Salon général introuvable.',
                        flags:
                            MessageFlags.Ephemeral
                    });

                    return;
                }

                await channel.send(
                    'Suis un fdp 💀'
                );

                await interaction.reply({
                    content:
                        '✅ Message envoyé.',
                    flags:
                        MessageFlags.Ephemeral
                });

                return;
            }

            // ==========================================
            // /compteur
            // ==========================================

            if (
                interaction.commandName ===
                'compteur'
            ) {

                if (interaction.channelId !== COUNT_CHANNEL_ID) {
                    await interaction.reply({
                        content:
                            `❌ La commande /compteur fonctionne uniquement dans <#${COUNT_CHANNEL_ID}>.`,
                        flags:
                            MessageFlags.Ephemeral
                    });

                    return;
                }

                if (counting) {
                    await interaction.reply({
                        content:
                            '⚠️ Le compteur tourne déjà.',
                        flags:
                            MessageFlags.Ephemeral
                    });

                    return;
                }

                await startCounter();

                await interaction.reply({
                    content:
                        `✅ Compteur lancé à **${count - 1}**.`,
                    flags:
                        MessageFlags.Ephemeral
                });

                return;
            }

            // ==========================================
            // /stopcompteur
            // ==========================================

            if (
                interaction.commandName ===
                'stopcompteur'
            ) {

                if (interaction.channelId !== COUNT_CHANNEL_ID) {
                    await interaction.reply({
                        content:
                            `❌ La commande /stopcompteur fonctionne uniquement dans <#${COUNT_CHANNEL_ID}>.`,
                        flags:
                            MessageFlags.Ephemeral
                    });

                    return;
                }

                if (!counting) {
                    await interaction.reply({
                        content:
                            `❌ Déjà arrêté à **${count - 1}**.`,
                        flags:
                            MessageFlags.Ephemeral
                    });

                    return;
                }

                const lastNumber =
                    count - 1;

                stopCounter();

                await interaction.reply({
                    content:
                        `🛑 Compteur arrêté à **${lastNumber}**.`,
                    flags:
                        MessageFlags.Ephemeral
                });

                return;
            }

            // ==========================================
            // /steamid
            // ==========================================

            if (
                interaction.commandName ===
                'steamid'
            ) {

                if (
                    interaction.channelId !==
                    STEAM_CHANNEL_ID
                ) {
                    await interaction.reply({
                        content:
                            '❌ Utilise `/steamid` dans le salon Steam.',
                        flags:
                            MessageFlags.Ephemeral
                    });

                    return;
                }

                const gameName =
                    interaction.options.getString(
                        'jeu'
                    );

                await interaction.deferReply();

                const results =
                    await searchSteamGame(
                        gameName
                    );

                if (!results.length) {
                    await interaction.editReply(
                        `❌ Aucun jeu trouvé pour **${gameName}**.`
                    );

                    return;
                }

                const best =
                    results[0];

                let description =
                    `🎮 **${best.name}**\n` +
                    `🆔 **Steam App ID :** \`${best.id}\`\n\n` +
                    `[🔗 Ouvrir sur Steam](https://store.steampowered.com/app/${best.id}/)`;

                if (
                    results.length >
                    1
                ) {
                    description +=
                        '\n\n**Autres résultats :**\n';

                    for (
                        const game of
                        results.slice(1)
                    ) {
                        description +=
                            `• ${game.name} — \`${game.id}\`\n`;
                    }
                }

                await interaction.editReply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                '🔎 Recherche Steam'
                            )
                            .setDescription(
                                description
                            )
                            .setColor(
                                0x5865F2
                            )
                    ]
                });

                return;
            }

            // ==========================================
            // /onlinefix
            // ==========================================

            if (
                interaction.commandName ===
                'onlinefix'
            ) {

                await interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                '⚡ Project Lightning'
                            )
                            .setDescription(
                                '[🌐 Ouvrir Project Lightning](https://project-lightning-web.vercel.app)'
                            )
                            .setColor(
                                0x5865F2
                            )
                    ]
                });

                return;
            }

            // ==========================================
            // /spotifyfree
            // ==========================================

            if (
                interaction.commandName ===
                'spotifyfree'
            ) {

                await interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                '🎵 Spicetify'
                            )
                            .setDescription(
                                '[🌐 Ouvrir Spicetify](https://spicetify.app)'
                            )
                            .setColor(
                                0x5865F2
                            )
                    ]
                });

                return;
            }

            // ==========================================
            // /pluginsteam
            // ==========================================

            if (
                interaction.commandName ===
                'pluginsteam'
            ) {

                await interaction.reply({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle(
                                '🧩 Plugins Steam'
                            )
                            .setDescription(
                                '[🌐 Ouvrir SteamBrew](https://steambrew.app)'
                            )
                            .setColor(
                                0x5865F2
                            )
                    ]
                });

                return;
            }

            // ==========================================
            // /panel
            // ==========================================

            if (
                interaction.commandName ===
                'panel'
            ) {

                const channel =
                    await client.channels.fetch(
                        PANEL_CHANNEL_ID
                    );

                if (
                    !channel ||
                    !channel.isTextBased()
                ) {
                    await interaction.reply({
                        content:
                            '❌ Salon panneau introuvable.',
                        flags:
                            MessageFlags.Ephemeral
                    });

                    return;
                }

                await channel.send(
                    createPanel()
                );

                await interaction.reply({
                    content:
                        '✅ Panneau envoyé.',
                    flags:
                        MessageFlags.Ephemeral
                });

                return;
            }

            // ==========================================
            // /say
            // ==========================================

            if (
                interaction.commandName ===
                'say'
            ) {

                const text =
                    interaction.options.getString(
                        'texte'
                    );

                await interaction.channel.send(
                    text
                );

                await interaction.reply({
                    content:
                        '✅ Message envoyé.',
                    flags:
                        MessageFlags.Ephemeral
                });

                return;
            }

            // ==========================================
            // /kick
            // ==========================================

            if (
                interaction.commandName ===
                'kick'
            ) {

                const user =
                    interaction.options.getUser(
                        'membre'
                    );

                const member =
                    await interaction.guild.members
                        .fetch(
                            user.id
                        )
                        .catch(
                            () => null
                        );

                if (
                    !member ||
                    !member.kickable
                ) {
                    await interaction.reply({
                        content:
                            '❌ Je ne peux pas expulser ce membre.',
                        flags:
                            MessageFlags.Ephemeral
                    });

                    return;
                }

                const reason =
                    interaction.options.getString(
                        'raison'
                    ) ||
                    'Aucune raison';

                await member.kick(
                    reason
                );

                await interaction.reply(
                    `👢 **${user.tag}** a été expulsé.\nRaison : ${reason}`
                );

                return;
            }

            // ==========================================
            // /ban
            // ==========================================

            if (
                interaction.commandName ===
                'ban'
            ) {

                const user =
                    interaction.options.getUser(
                        'membre'
                    );

                const member =
                    await interaction.guild.members
                        .fetch(
                            user.id
                        )
                        .catch(
                            () => null
                        );

                if (
                    member &&
                    !member.bannable
                ) {
                    await interaction.reply({
                        content:
                            '❌ Je ne peux pas bannir ce membre.',
                        flags:
                            MessageFlags.Ephemeral
                    });

                    return;
                }

                const reason =
                    interaction.options.getString(
                        'raison'
                    ) ||
                    'Aucune raison';

                await interaction.guild.members.ban(
                    user.id,
                    {
                        reason
                    }
                );

                await interaction.reply(
                    `🔨 **${user.tag}** a été banni.\nRaison : ${reason}`
                );

                return;
            }

            // ==========================================
            // /timeout
            // ==========================================

            if (
                interaction.commandName ===
                'timeout'
            ) {

                const user =
                    interaction.options.getUser(
                        'membre'
                    );

                const member =
                    await interaction.guild.members
                        .fetch(
                            user.id
                        )
                        .catch(
                            () => null
                        );

                if (
                    !member ||
                    !member.moderatable
                ) {
                    await interaction.reply({
                        content:
                            '❌ Je ne peux pas exclure ce membre.',
                        flags:
                            MessageFlags.Ephemeral
                    });

                    return;
                }

                const seconds =
                    interaction.options.getInteger(
                        'secondes'
                    );

                const reason =
                    interaction.options.getString(
                        'raison'
                    ) ||
                    'Aucune raison';

                await member.timeout(
                    seconds * 1000,
                    reason
                );

                await interaction.reply(
                    `⏱️ **${user.tag}** est exclu pendant **${seconds} seconde(s)**.`
                );

                return;
            }

            // ==========================================
            // /untimeout
            // ==========================================

            if (
                interaction.commandName ===
                'untimeout'
            ) {

                const user =
                    interaction.options.getUser(
                        'membre'
                    );

                const member =
                    await interaction.guild.members
                        .fetch(
                            user.id
                        )
                        .catch(
                            () => null
                        );

                if (
                    !member ||
                    !member.moderatable
                ) {
                    await interaction.reply({
                        content:
                            '❌ Je ne peux pas modifier ce membre.',
                        flags:
                            MessageFlags.Ephemeral
                    });

                    return;
                }

                await member.timeout(
                    null,
                    'Exclusion temporaire retirée'
                );

                await interaction.reply(
                    `✅ Exclusion retirée pour **${user.tag}**.`
                );

                return;
            }

            // ==========================================
            // /8ball
            // ==========================================

            if (
                interaction.commandName ===
                '8ball'
            ) {

                const answers = [
                    'Oui.',
                    'Non.',
                    'Peut-être.',
                    'Certainement.',
                    'Pas du tout.',
                    'Je ne sais pas 😭'
                ];

                const question =
                    interaction.options.getString(
                        'question'
                    );

                const answer =
                    answers[
                        Math.floor(
                            Math.random() *
                            answers.length
                        )
                    ];

                await interaction.reply(
                    `🎱 **${question}**\n→ ${answer}`
                );

                return;
            }

            // ==========================================
            // /coinflip
            // ==========================================

            if (
                interaction.commandName ===
                'coinflip'
            ) {

                const result =
                    Math.random() < 0.5
                        ? 'Pile'
                        : 'Face';

                await interaction.reply(
                    `🪙 **${result}**`
                );

                return;
            }

            // ==========================================
            // /roll
            // ==========================================

            if (
                interaction.commandName ===
                'roll'
            ) {

                const max =
                    interaction.options.getInteger(
                        'max'
                    ) ||
                    100;

                const result =
                    Math.floor(
                        Math.random() *
                        max
                    ) + 1;

                await interaction.reply(
                    `🎲 **${result}** / ${max}`
                );

                return;
            }

            // ==========================================
            // /random
            // ==========================================

            if (
                interaction.commandName ===
                'random'
            ) {

                let min =
                    interaction.options.getInteger(
                        'min'
                    );

                let max =
                    interaction.options.getInteger(
                        'max'
                    );

                if (min > max) {
                    [
                        min,
                        max
                    ] = [
                        max,
                        min
                    ];
                }

                const result =
                    Math.floor(
                        Math.random() *
                        (
                            max -
                            min +
                            1
                        )
                    ) + min;

                await interaction.reply(
                    `🎯 **${result}**`
                );

                return;
            }

            // ==========================================
            // /clear10 -> /clear100
            // ==========================================

            const clearMatch =
                interaction.commandName.match(
                    /^clear(10|20|30|40|50|60|70|80|90|100)$/
                );

            if (clearMatch) {

                const amount =
                    Number(
                        clearMatch[1]
                    );

                if (
                    !interaction.memberPermissions?.has(
                        PermissionFlagsBits.ManageMessages
                    )
                ) {
                    await interaction.reply({
                        content:
                            '❌ Tu dois avoir **Gérer les messages**.',
                        flags:
                            MessageFlags.Ephemeral
                    });

                    return;
                }

                const botMember =
                    interaction.guild.members.me;

                if (
                    !botMember?.permissions.has(
                        PermissionFlagsBits.ManageMessages
                    )
                ) {
                    await interaction.reply({
                        content:
                            '❌ Je dois avoir **Gérer les messages**.',
                        flags:
                            MessageFlags.Ephemeral
                    });

                    return;
                }

                if (
                    !interaction.channel ||
                    !interaction.channel.isTextBased()
                ) {
                    await interaction.reply({
                        content:
                            '❌ Cette commande ne fonctionne pas ici.',
                        flags:
                            MessageFlags.Ephemeral
                    });

                    return;
                }

                const deleted =
                    await interaction.channel.bulkDelete(
                        amount,
                        true
                    );

                await interaction.reply({
                    content:
                        `🧹 **${deleted.size}** message(s) supprimé(s).`,
                    flags:
                        MessageFlags.Ephemeral
                });

                return;
            }

        } catch (error) {

            console.error(
                '❌ Interaction error :',
                error
            );

            if (
                interaction.replied ||
                interaction.deferred
            ) {
                await interaction.editReply(
                    '❌ Une erreur est survenue.'
                );
            } else {
                await interaction.reply({
                    content:
                        '❌ Une erreur est survenue.',
                    flags:
                        MessageFlags.Ephemeral
                });
            }
        }
    }
);

// ==================================================
// ERREURS
// ==================================================

process.on(
    'unhandledRejection',
    error => {
        console.error(
            '❌ Unhandled Rejection :',
            error
        );
    }
);

process.on(
    'uncaughtException',
    error => {
        console.error(
            '❌ Uncaught Exception :',
            error
        );
    }
);

// ==================================================
// VÉRIFICATIONS
// ==================================================

if (!process.env.TOKEN) {
    console.error(
        '❌ TOKEN absent du fichier .env'
    );

    process.exit(1);
}

if (!process.env.OPENAI_API_KEY) {
    console.warn(
        '⚠️ OPENAI_API_KEY absent. Le bot démarrera, mais /ia sera désactivé.'
    );
}

// ==================================================
// LOGIN
// ==================================================

client.login(
    process.env.TOKEN
);
// Railway redeploy
