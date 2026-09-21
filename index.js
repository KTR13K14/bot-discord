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

const { GoogleGenAI } = require('@google/genai');

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
// GEMINI
// ==================================================

const GEMINI_MODEL = 'gemini-3.6-flash';

const gemini = process.env.GEMINI_API_KEY
    ? new GoogleGenAI({
        apiKey: process.env.GEMINI_API_KEY
    })
    : null;

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

const AI_TIMEOUT_MS = 2 * 60 * 1000;

let activeAIChannelId = AI_CHANNEL_ID;
let aiInactivityTimer = null;

const aiChannelTimers = new Map();
const aiHistory = new Map();

const MAX_HISTORY = 12;

// ==================================================
// OUTILS INTERACTION
// ==================================================

function isInteractionGone(error) {
    return (
        error?.code === 10062 ||
        error?.code === 40060 ||
        error?.status === 404 ||
        error?.message?.includes('Unknown interaction') ||
        error?.message?.includes('already been acknowledged')
    );
}

async function safeDefer(interaction) {
    if (interaction.replied || interaction.deferred) {
        return true;
    }

    try {
        await interaction.deferReply();
        return true;
    } catch (error) {
        if (isInteractionGone(error)) {
            console.warn(
                '⚠️ Interaction déjà traitée ou expirée.'
            );
            return false;
        }

        console.error(
            '❌ Erreur deferReply :',
            error
        );

        return false;
    }
}

async function safeReply(interaction, data) {
    if (!interaction || !interaction.isRepliable()) {
        return false;
    }

    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(data);
        } else {
            await interaction.reply(data);
        }

        return true;
    } catch (error) {
        if (!isInteractionGone(error)) {
            console.error(
                '❌ Erreur réponse interaction :',
                error
            );
        }

        return false;
    }
}

async function safeEditReply(interaction, data) {
    try {
        if (
            !interaction.replied &&
            !interaction.deferred
        ) {
            return await safeReply(
                interaction,
                data
            );
        }

        await interaction.editReply(data);
        return true;
    } catch (error) {
        if (!isInteractionGone(error)) {
            console.error(
                '❌ Erreur editReply :',
                error
            );
        }

        return false;
    }
}

// ==================================================
// HISTORIQUE IA
// ==================================================

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
// SALON IA
// ==================================================

function clearAIInactivityTimer(channelId) {
    if (!channelId) {
        channelId = activeAIChannelId;
    }

    if (
        channelId === activeAIChannelId &&
        aiInactivityTimer
    ) {
        clearTimeout(aiInactivityTimer);
        aiInactivityTimer = null;
    }

    const timer = aiChannelTimers.get(channelId);

    if (timer) {
        clearTimeout(timer);
        aiChannelTimers.delete(channelId);
    }
}

function resetAIInactivityTimer(channelId) {
    clearAIInactivityTimer(channelId);

    if (channelId === activeAIChannelId) {
        aiInactivityTimer = setTimeout(
            async () => {
                try {
                    await closeAndRecreateAIChannel();
                } catch (error) {
                    console.error(
                        '❌ Erreur renouvellement IA :',
                        error
                    );
                }
            },
            AI_TIMEOUT_MS
        );

        return;
    }

    const timer = setTimeout(
        () => {
            aiHistory.delete(channelId);
            aiChannelTimers.delete(channelId);

            console.log(
                `🧠 Historique IA supprimé pour ${channelId}.`
            );
        },
        AI_TIMEOUT_MS
    );

    aiChannelTimers.set(
        channelId,
        timer
    );
}

async function findOrCreateAIChannel(guild) {
    let channel =
        guild.channels.cache.get(
            activeAIChannelId
        );

    if (
        channel &&
        channel.type === ChannelType.GuildText
    ) {
        return channel;
    }

    channel =
        guild.channels.cache.find(
            ch =>
                ch.type === ChannelType.GuildText &&
                ch.name === 'ia'
        );

    if (channel) {
        activeAIChannelId = channel.id;
        return channel;
    }

    channel =
        await guild.channels.create({
            name: 'ia',
            type: ChannelType.GuildText,
            reason: 'Création du salon IA'
        });

    activeAIChannelId = channel.id;

    await channel.send(
        '🤖 **Nouveau salon IA prêt !**\n' +
        'Utilise `/ia question:` pour commencer.'
    );

    return channel;
}

async function closeAndRecreateAIChannel() {
    clearAIInactivityTimer();

    const oldChannelId =
        activeAIChannelId;

    try {
        const guild =
            client.guilds.cache.get(
                GUILD_ID
            );

        if (!guild) {
            console.error(
                '❌ Serveur introuvable.'
            );
            return;
        }

        const oldChannel =
            await client.channels
                .fetch(oldChannelId)
                .catch(() => null);

        let permissionOverwrites;

        if (
            oldChannel?.permissionOverwrites?.cache
        ) {
            permissionOverwrites =
                [
                    ...oldChannel
                        .permissionOverwrites
                        .cache
                        .values()
                ].map(
                    overwrite =>
                        overwrite.toJSON()
                );
        }

        const newChannel =
            await guild.channels.create({
                name: 'ia',
                type: ChannelType.GuildText,
                parent:
                    oldChannel?.parentId ||
                    undefined,
                permissionOverwrites,
                reason:
                    'Renouvellement du salon IA après 2 minutes'
            });

        activeAIChannelId =
            newChannel.id;

        aiHistory.delete(
            oldChannelId
        );

        await newChannel.send({
            content:
                '@everyone\n\n' +
                '🔒 **Conversation terminée.**\n' +
                'Aucune question pendant **2 minutes**.\n\n' +
                '🧠 L’historique précédent a été supprimé.\n\n' +
                '🤖 **Nouvelle conversation ouverte !**\n' +
                'Utilise `/ia question:` pour commencer.',
            allowedMentions: {
                parse: ['everyone']
            }
        });

        if (
            oldChannel &&
            oldChannel.deletable
        ) {
            await oldChannel.delete(
                'Conversation IA terminée après 2 minutes'
            );
        }

        console.log(
            `🤖 Salon IA renouvelé : ${newChannel.id}`
        );

        aiInactivityTimer = null;

    } catch (error) {
        console.error(
            '❌ Impossible de renouveler le salon IA :',
            error
        );

        aiHistory.delete(
            oldChannelId
        );

        aiInactivityTimer = null;
    }
}

// ==================================================
// IA GEMINI
// ==================================================

async function askAI(
    channelId,
    question,
    userName,
    imageUrls = []
) {
    if (!gemini) {
        throw new Error(
            'GEMINI_API_KEY absente.'
        );
    }

    const history =
        getHistory(channelId);

    const systemPrompt = `
Tu es KTR.BOT, un assistant IA intégré à Discord.

Tu réponds en français sauf si l'utilisateur demande une autre langue.

Tu aides notamment pour :
- programmation JavaScript / Node.js / Python
- bots Discord
- dépannage informatique
- erreurs de code
- configuration PC
- jeux vidéo
- questions générales
- projets

Tu peux analyser les images.

Quand une image est fournie :
- regarde attentivement ce qui est visible
- lis le texte visible quand c'est possible
- réponds à la question avec les informations visibles
- ne prétends jamais voir quelque chose qui n'est pas visible

Quand tu fournis du code :
- donne du code complet si nécessaire
- explique où le mettre
- évite de supprimer des fonctionnalités sans raison
- donne des solutions simples et fonctionnelles

Sois direct, utile et clair.

Utilisateur Discord :
${userName}
`;

    const contents =
        history.map(item => ({
            role:
                item.role === 'assistant'
                    ? 'model'
                    : 'user',
            parts: [
                {
                    text:
                        typeof item.content === 'string'
                            ? item.content
                            : '[Image]'
                }
            ]
        }));

    const currentParts = [];

    if (
        typeof question === 'string' &&
        question.trim()
    ) {
        currentParts.push({
            text: question.trim()
        });
    }

    if (
        !currentParts.length &&
        imageUrls.length
    ) {
        currentParts.push({
            text:
                'Analyse cette image.'
        });
    }

    for (
        const imageUrl of imageUrls.slice(0, 5)
    ) {
        try {
            const response =
                await fetch(imageUrl);

            if (!response.ok) {
                continue;
            }

            const buffer =
                Buffer.from(
                    await response.arrayBuffer()
                );

            if (
                buffer.length >
                4 * 1024 * 1024
            ) {
                console.warn(
                    '⚠️ Image trop grosse.'
                );
                continue;
            }

            const mimeType =
                (
                    response.headers.get(
                        'content-type'
                    ) ||
                    'image/jpeg'
                ).split(';')[0];

            if (
                !mimeType.startsWith(
                    'image/'
                )
            ) {
                continue;
            }

            currentParts.push({
                inlineData: {
                    mimeType,
                    data:
                        buffer.toString(
                            'base64'
                        )
                }
            });

        } catch (error) {
            console.error(
                '❌ Erreur récupération image :',
                error
            );
        }
    }

    if (!currentParts.length) {
        currentParts.push({
            text:
                question ||
                'Bonjour.'
        });
    }

    contents.push({
        role: 'user',
        parts: currentParts
    });

    console.log(
        `🤖 Question Gemini dans ${channelId}`
    );

    let response;

    try {
        response =
            await gemini.models.generateContent({
                model: GEMINI_MODEL,
                contents,
                config: {
                    systemInstruction:
                        systemPrompt
                }
            });
    } catch (error) {
        console.error(
            '❌ ERREUR GEMINI :',
            error
        );

        throw error;
    }

    const answer =
        response.text?.trim();

    if (!answer) {
        throw new Error(
            'Gemini a renvoyé une réponse vide.'
        );
    }

    addHistory(
        channelId,
        'user',
        imageUrls.length
            ? `${question || 'Analyse cette image.'}\n[Image envoyée]`
            : question
    );

    addHistory(
        channelId,
        'assistant',
        answer
    );

    return answer;
}

// ==================================================
// COMPTEUR
// ==================================================

const COUNTER_FILE =
    path.join(
        __dirname,
        'counter.json'
    );

let count = 1;
let counting = false;
let countInterval = null;

if (
    fs.existsSync(
        COUNTER_FILE
    )
) {
    try {
        const saved =
            JSON.parse(
                fs.readFileSync(
                    COUNTER_FILE,
                    'utf8'
                )
            );

        if (
            Number.isInteger(
                saved.count
            ) &&
            saved.count >= 1
        ) {
            count =
                saved.count;
        }
    } catch {
        console.warn(
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
        clearInterval(
            countInterval
        );

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

    countInterval =
        setInterval(
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
            channel.guild
                .voiceAdapterCreator,
        selfMute: true,
        selfDeaf: true
    });
}

// ==================================================
// STEAM
// ==================================================

async function searchSteamGame(
    gameName
) {
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

    return (
        data.items?.slice(0, 5) ||
        []
    );
}

// ==================================================
// PANEL
// ==================================================

function createPanel() {
    const embed =
        new EmbedBuilder()
            .setTitle(
                '⚡ KTR.BOT — RESSOURCES'
            )
            .setDescription(
                'Bienvenue 👋\n\n' +
                'Choisis une ressource :\n\n' +
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
                'Sélectionne une option...'
            )
            .addOptions(
                {
                    label:
                        'Spotify / Spicetify',
                    description:
                        'Ouvrir Spicetify',
                    value:
                        'spotify',
                    emoji: '🎵'
                },
                {
                    label:
                        'Plugins Steam',
                    description:
                        'Ouvrir SteamBrew',
                    value:
                        'plugins',
                    emoji: '🧩'
                },
                {
                    label:
                        'Project Lightning',
                    description:
                        'Ouvrir Project Lightning',
                    value:
                        'lightning',
                    emoji: '⚡'
                },
                {
                    label: 'Steam',
                    description:
                        'Ouvrir Steam',
                    value:
                        'steam',
                    emoji: '🎮'
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
        Math.floor(
            ms / 1000
        );

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
            'Affiche le ping'
        ),

    new SlashCommandBuilder()
        .setName('uptime')
        .setDescription(
            'Affiche le temps de fonctionnement'
        ),

    new SlashCommandBuilder()
        .setName('avatar')
        .setDescription(
            'Affiche un avatar'
        )
        .addUserOption(
            o =>
                o.setName('membre')
                    .setDescription(
                        'Membre'
                    )
                    .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('userinfo')
        .setDescription(
            'Informations sur un membre'
        )
        .addUserOption(
            o =>
                o.setName('membre')
                    .setDescription(
                        'Membre'
                    )
                    .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('serverinfo')
        .setDescription(
            'Informations du serveur'
        ),

    new SlashCommandBuilder()
        .setName('botinfo')
        .setDescription(
            'Informations du bot'
        ),

    new SlashCommandBuilder()
        .setName('channelinfo')
        .setDescription(
            'Informations d’un salon'
        )
        .addChannelOption(
            o =>
                o.setName('salon')
                    .setDescription(
                        'Salon'
                    )
                    .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('grosfdp')
        .setDescription(
            'Rejoint ton vocal'
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
            'Cherche le Steam App ID'
        )
        .addStringOption(
            o =>
                o.setName('jeu')
                    .setDescription(
                        'Nom du jeu'
                    )
                    .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('onlinefix')
        .setDescription(
            'Project Lightning'
        ),

    new SlashCommandBuilder()
        .setName('spotifyfree')
        .setDescription(
            'Spicetify'
        ),

    new SlashCommandBuilder()
        .setName('pluginsteam')
        .setDescription(
            'SteamBrew'
        ),

    new SlashCommandBuilder()
        .setName('panel')
        .setDescription(
            'Envoie le panneau'
        ),

    new SlashCommandBuilder()
        .setName('ia')
        .setDescription(
            'Pose une question à Gemini'
        )
        .addStringOption(
            o =>
                o.setName('question')
                    .setDescription(
                        'Ta question'
                    )
                    .setRequired(true)
        )
        .addAttachmentOption(
            o =>
                o.setName('image')
                    .setDescription(
                        'Image à analyser'
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
            o =>
                o.setName('texte')
                    .setDescription(
                        'Texte'
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
            o =>
                o.setName('membre')
                    .setDescription(
                        'Membre'
                    )
                    .setRequired(true)
        )
        .addStringOption(
            o =>
                o.setName('raison')
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
            o =>
                o.setName('membre')
                    .setDescription(
                        'Membre'
                    )
                    .setRequired(true)
        )
        .addStringOption(
            o =>
                o.setName('raison')
                    .setDescription(
                        'Raison'
                    )
                    .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('timeout')
        .setDescription(
            'Timeout un membre'
        )
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ModerateMembers
        )
        .addUserOption(
            o =>
                o.setName('membre')
                    .setDescription(
                        'Membre'
                    )
                    .setRequired(true)
        )
        .addIntegerOption(
            o =>
                o.setName('secondes')
                    .setDescription(
                        'Durée'
                    )
                    .setRequired(true)
                    .setMinValue(1)
                    .setMaxValue(2419200)
        )
        .addStringOption(
            o =>
                o.setName('raison')
                    .setDescription(
                        'Raison'
                    )
                    .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('untimeout')
        .setDescription(
            'Retire le timeout'
        )
        .setDefaultMemberPermissions(
            PermissionFlagsBits.ModerateMembers
        )
        .addUserOption(
            o =>
                o.setName('membre')
                    .setDescription(
                        'Membre'
                    )
                    .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('8ball')
        .setDescription(
            'Pose une question'
        )
        .addStringOption(
            o =>
                o.setName('question')
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
            o =>
                o.setName('max')
                    .setDescription(
                        'Maximum'
                    )
                    .setRequired(false)
                    .setMinValue(2)
                    .setMaxValue(1000000)
        ),

    new SlashCommandBuilder()
        .setName('random')
        .setDescription(
            'Nombre aléatoire'
        )
        .addIntegerOption(
            o =>
                o.setName('min')
                    .setDescription(
                        'Minimum'
                    )
                    .setRequired(true)
        )
        .addIntegerOption(
            o =>
                o.setName('max')
                    .setDescription(
                        'Maximum'
                    )
                    .setRequired(true)
        ),

    ...[
        10, 20, 30, 40, 50,
        60, 70, 80, 90, 100
    ].map(
        n =>
            new SlashCommandBuilder()
                .setName(`clear${n}`)
                .setDescription(
                    `Supprime ${n} messages`
                )
                .setDefaultMemberPermissions(
                    PermissionFlagsBits.ManageMessages
                )
    )
].map(command =>
    command.toJSON()
);

// ==================================================
// ENREGISTREMENT COMMANDES
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
        '✅ Commandes Discord installées.'
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

        await registerCommands();

        const guild =
            client.guilds.cache.get(
                GUILD_ID
            );

        if (!guild) {
            console.error(
                '❌ Serveur introuvable.'
            );
            return;
        }

        const aiChannel =
            await findOrCreateAIChannel(
                guild
            );

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
            try {
                connectToVoice(
                    voiceChannel
                );

                console.log(
                    `🔊 Connecté à ${voiceChannel.name}`
                );
            } catch (error) {
                console.error(
                    '❌ Erreur vocal :',
                    error
                );
            }
        } else {
            console.warn(
                '⚠️ Vocal introuvable.'
            );
        }

        console.log(
            `🔢 Compteur sauvegardé : ${count}`
        );

        if (gemini) {
            console.log(
                `🤖 IA Gemini activée avec ${GEMINI_MODEL}.`
            );
        } else {
            console.warn(
                '⚠️ GEMINI_API_KEY absente.'
            );
        }
    }
);

// ==================================================
// MESSAGES NORMAUX DANS LES CONVERSATIONS IA
// ==================================================

client.on(
    'messageCreate',
    async message => {
        if (
            message.author.bot ||
            !message.guild ||
            message.content.startsWith('/')
        ) {
            return;
        }

        const channelId =
            message.channelId;

        const history =
            aiHistory.get(channelId);

        if (
            !history ||
            history.length === 0
        ) {
            return;
        }

        if (!gemini) {
            return;
        }

        try {
            await message.channel.sendTyping();

            const imageUrls =
                [
                    ...message.attachments.values()
                ]
                    .filter(
                        attachment => {
                            const type =
                                attachment.contentType ||
                                '';

                            return (
                                type.startsWith(
                                    'image/'
                                ) ||
                                /\.(png|jpe?g|gif|webp|bmp|avif)(\?|$)/i.test(
                                    attachment.url
                                )
                            );
                        }
                    )
                    .map(
                        attachment =>
                            attachment.url
                    )
                    .slice(0, 5);

            const answer =
                await askAI(
                    channelId,
                    message.content ||
                        'Analyse cette image.',
                    message.author.username,
                    imageUrls
                );

            resetAIInactivityTimer(
                channelId
            );

            if (
                answer.length <= 2000
            ) {
                await message.reply(
                    answer
                );
            } else {
                const parts =
                    answer.match(
                        /.{1,1900}/gs
                    ) || [];

                if (parts[0]) {
                    await message.reply(
                        parts[0]
                    );
                }

                for (
                    const part of
                    parts.slice(1)
                ) {
                    await message.channel.send(
                        part
                    );
                }
            }

        } catch (error) {
            console.error(
                '❌ Erreur IA message :',
                error
            );

            await message.reply(
                '❌ Une erreur est survenue avec l’IA.'
            ).catch(() => {});
        }
    }
);

// ==================================================
// INTERACTIONS
// ==================================================

client.on(
    'interactionCreate',
    async interaction => {
        try {

            // ==========================================
            // MENU RESSOURCES
            // ==========================================

            if (
                interaction.isStringSelectMenu() &&
                interaction.customId ===
                    'resource_menu'
            ) {
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

                await safeReply(
                    interaction,
                    {
                        content:
                            links[
                                interaction.values[0]
                            ],
                        flags:
                            MessageFlags.Ephemeral
                    }
                );

                return;
            }

            if (
                !interaction.isChatInputCommand()
            ) {
                return;
            }

            const command =
                interaction.commandName;

            // ==========================================
            // /ia
            // ==========================================

            if (command === 'ia') {

                if (!gemini) {
                    await safeReply(
                        interaction,
                        {
                            content:
                                '❌ GEMINI_API_KEY n’est pas configurée.',
                            flags:
                                MessageFlags.Ephemeral
                        }
                    );

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

                const imageUrls =
                    image
                        ? [image.url]
                        : [];

                // IMPORTANT :
                // on répond à Discord immédiatement.
                const deferred =
                    await safeDefer(
                        interaction
                    );

                if (!deferred) {
                    return;
                }

                try {
                    const answer =
                        await askAI(
                            interaction.channelId,
                            question,
                            interaction.user.username,
                            imageUrls
                        );

                    resetAIInactivityTimer(
                        interaction.channelId
                    );

                    if (
                        answer.length <= 2000
                    ) {
                        await safeEditReply(
                            interaction,
                            answer
                        );
                    } else {
                        const parts =
                            answer.match(
                                /.{1,1900}/gs
                            ) || [];

                        if (parts[0]) {
                            await safeEditReply(
                                interaction,
                                parts[0]
                            );
                        }

                        for (
                            const part of
                            parts.slice(1)
                        ) {
                            await interaction.channel.send(
                                part
                            );
                        }
                    }

                } catch (error) {
                    console.error(
                        '❌ ERREUR /IA :',
                        error
                    );

                    await safeEditReply(
                        interaction,
                        '❌ Gemini a rencontré une erreur. Regarde les logs Railway.'
                    );
                }

                return;
            }

            // ==========================================
            // /help
            // ==========================================

            if (command === 'help') {
                await safeReply(
                    interaction,
                    {
                        embeds: [
                            new EmbedBuilder()
                                .setTitle(
                                    '📚 KTR.BOT — COMMANDES'
                                )
                                .setDescription(
                                    '**🤖 IA**\n' +
                                    '`/ia question:`\n' +
                                    'Conversation continue + images.\n' +
                                    'Le salon IA est renouvelé après 2 minutes.\n\n' +

                                    '**🔊 Vocal**\n' +
                                    '`/grosfdp` `/rejoin` `/fdp`\n\n' +

                                    '**🛠️ Modération**\n' +
                                    '`/clear10` → `/clear100`\n' +
                                    '`/kick` `/ban` `/timeout` `/untimeout` `/say`\n\n' +

                                    '**📊 Infos**\n' +
                                    '`/ping` `/uptime` `/avatar` `/userinfo`\n' +
                                    '`/serverinfo` `/botinfo` `/channelinfo`\n\n' +

                                    '**🎮 Steam / Ressources**\n' +
                                    '`/steamid` `/onlinefix` `/spotifyfree` `/pluginsteam` `/panel`\n\n' +

                                    '**🔢 Outils**\n' +
                                    '`/compteur` `/stopcompteur` `/8ball` `/coinflip` `/roll` `/random`'
                                )
                                .setColor(
                                    0x5865F2
                                )
                        ]
                    }
                );

                return;
            }

            // ==========================================
            // /ping
            // ==========================================

            if (command === 'ping') {
                await safeReply(
                    interaction,
                    `🏓 Pong ! **${client.ws.ping} ms**`
                );
                return;
            }

            // ==========================================
            // /uptime
            // ==========================================

            if (command === 'uptime') {
                await safeReply(
                    interaction,
                    `⏱️ Le bot tourne depuis **${formatUptime(client.uptime || 0)}**.`
                );
                return;
            }

            // ==========================================
            // /avatar
            // ==========================================

            if (command === 'avatar') {
                const user =
                    interaction.options.getUser(
                        'membre'
                    ) ||
                    interaction.user;

                await safeReply(
                    interaction,
                    {
                        embeds: [
                            new EmbedBuilder()
                                .setTitle(
                                    `🖼️ Avatar de ${user.username}`
                                )
                                .setImage(
                                    user.displayAvatarURL({
                                        size: 1024,
                                        extension: 'png'
                                    })
                                )
                                .setColor(
                                    0x5865F2
                                )
                        ]
                    }
                );

                return;
            }

            // ==========================================
            // /userinfo
            // ==========================================

            if (command === 'userinfo') {
                const user =
                    interaction.options.getUser(
                        'membre'
                    );

                const member =
                    await interaction.guild.members
                        .fetch(user.id)
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
                        name: '👤 Pseudo',
                        value:
                            `\`${user.username}\``
                    },
                    {
                        name: '📛 Nom',
                        value:
                            user.globalName ||
                            'Aucun'
                    },
                    {
                        name: '📅 Création',
                        value:
                            `<t:${created}:F>\n<t:${created}:R>`
                    },
                    {
                        name: '🤖 Type',
                        value:
                            user.bot
                                ? 'Bot'
                                : 'Utilisateur'
                    }
                ];

                if (
                    member?.joinedTimestamp
                ) {
                    fields.push({
                        name:
                            '📥 Arrivée',
                        value:
                            `<t:${Math.floor(member.joinedTimestamp / 1000)}:F>`
                    });
                }

                await safeReply(
                    interaction,
                    {
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
                    }
                );

                return;
            }

            // ==========================================
            // /serverinfo
            // ==========================================

            if (command === 'serverinfo') {
                const guild =
                    interaction.guild;

                await safeReply(
                    interaction,
                    {
                        embeds: [
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
                                            `<t:${Math.floor(guild.createdTimestamp / 1000)}:F>`
                                    }
                                )
                                .setColor(
                                    0x5865F2
                                )
                        ]
                    }
                );

                return;
            }

            // ==========================================
            // /botinfo
            // ==========================================

            if (command === 'botinfo') {
                await safeReply(
                    interaction,
                    {
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
                                            gemini
                                                ? 'Gemini activée'
                                                : 'Non configurée'
                                    }
                                )
                                .setColor(
                                    0x5865F2
                                )
                        ]
                    }
                );

                return;
            }

            // ==========================================
            // /channelinfo
            // ==========================================

            if (command === 'channelinfo') {
                const channel =
                    interaction.options.getChannel(
                        'salon'
                    );

                await safeReply(
                    interaction,
                    {
                        embeds: [
                            new EmbedBuilder()
                                .setTitle(
                                    `📺 ${channel.name}`
                                )
                                .addFields(
                                    {
                                        name: '🆔 ID',
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
                    }
                );

                return;
            }

            // ==========================================
            // /grosfdp /rejoin
            // ==========================================

            if (
                command === 'grosfdp' ||
                command === 'rejoin'
            ) {
                const channel =
                    interaction.member?.voice
                        ?.channel;

                if (!channel) {
                    await safeReply(
                        interaction,
                        {
                            content:
                                '❌ Tu dois être dans un vocal.',
                            flags:
                                MessageFlags.Ephemeral
                        }
                    );

                    return;
                }

                const old =
                    getVoiceConnection(
                        interaction.guild.id
                    );

                if (old) {
                    old.destroy();
                }

                connectToVoice(
                    channel
                );

                await safeReply(
                    interaction,
                    `✅ Rejoint **${channel.name}** 🔇🎧`
                );

                return;
            }

            // ==========================================
            // /fdp
            // ==========================================

            if (command === 'fdp') {
                const connection =
                    getVoiceConnection(
                        interaction.guild.id
                    );

                if (!connection) {
                    await safeReply(
                        interaction,
                        {
                            content:
                                '❌ Je ne suis dans aucun vocal.',
                            flags:
                                MessageFlags.Ephemeral
                        }
                    );

                    return;
                }

                connection.destroy();

                await safeReply(
                    interaction,
                    '👋 J’ai quitté le vocal.'
                );

                return;
            }

            // ==========================================
            // /parle
            // ==========================================

            if (command === 'parle') {
                const channel =
                    await client.channels.fetch(
                        GENERAL_CHANNEL_ID
                    );

                if (
                    !channel ||
                    !channel.isTextBased()
                ) {
                    await safeReply(
                        interaction,
                        {
                            content:
                                '❌ Salon général introuvable.',
                            flags:
                                MessageFlags.Ephemeral
                        }
                    );

                    return;
                }

                await channel.send(
                    'Suis un fdp 💀'
                );

                await safeReply(
                    interaction,
                    {
                        content:
                            '✅ Message envoyé.',
                        flags:
                            MessageFlags.Ephemeral
                    }
                );

                return;
            }

            // ==========================================
            // COMPTEUR
            // ==========================================

            if (
                command === 'compteur' ||
                command === 'stopcompteur'
            ) {
                if (
                    interaction.channelId !==
                    COUNT_CHANNEL_ID
                ) {
                    await safeReply(
                        interaction,
                        {
                            content:
                                `❌ Cette commande fonctionne uniquement dans <#${COUNT_CHANNEL_ID}>.`,
                            flags:
                                MessageFlags.Ephemeral
                        }
                    );

                    return;
                }

                if (
                    command === 'compteur'
                ) {
                    if (counting) {
                        await safeReply(
                            interaction,
                            {
                                content:
                                    '⚠️ Le compteur tourne déjà.',
                                flags:
                                    MessageFlags.Ephemeral
                            }
                        );

                        return;
                    }

                    await startCounter();

                    await safeReply(
                        interaction,
                        {
                            content:
                                `✅ Compteur lancé à **${count - 1}**.`,
                            flags:
                                MessageFlags.Ephemeral
                        }
                    );

                    return;
                }

                if (!counting) {
                    await safeReply(
                        interaction,
                        {
                            content:
                                `❌ Déjà arrêté à **${count - 1}**.`,
                            flags:
                                MessageFlags.Ephemeral
                        }
                    );

                    return;
                }

                const lastNumber =
                    count - 1;

                stopCounter();

                await safeReply(
                    interaction,
                    {
                        content:
                            `🛑 Compteur arrêté à **${lastNumber}**.`,
                        flags:
                            MessageFlags.Ephemeral
                    }
                );

                return;
            }

            // ==========================================
            // /steamid
            // ==========================================

            if (command === 'steamid') {
                if (
                    interaction.channelId !==
                    STEAM_CHANNEL_ID
                ) {
                    await safeReply(
                        interaction,
                        {
                            content:
                                '❌ Utilise `/steamid` dans le salon Steam.',
                            flags:
                                MessageFlags.Ephemeral
                        }
                    );

                    return;
                }

                const gameName =
                    interaction.options.getString(
                        'jeu'
                    );

                if (
                    !await safeDefer(
                        interaction
                    )
                ) {
                    return;
                }

                try {
                    const results =
                        await searchSteamGame(
                            gameName
                        );

                    if (!results.length) {
                        await safeEditReply(
                            interaction,
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
                        results.length > 1
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

                    await safeEditReply(
                        interaction,
                        {
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
                        }
                    );

                } catch (error) {
                    console.error(
                        '❌ Erreur Steam :',
                        error
                    );

                    await safeEditReply(
                        interaction,
                        '❌ Erreur pendant la recherche Steam.'
                    );
                }

                return;
            }

            // ==========================================
            // RESSOURCES
            // ==========================================

            const resourceLinks = {
                onlinefix: [
                    '⚡ Project Lightning',
                    'https://project-lightning-web.vercel.app'
                ],
                spotifyfree: [
                    '🎵 Spicetify',
                    'https://spicetify.app'
                ],
                pluginsteam: [
                    '🧩 SteamBrew',
                    'https://steambrew.app'
                ]
            };

            if (
                resourceLinks[command]
            ) {
                const [
                    title,
                    url
                ] =
                    resourceLinks[
                        command
                    ];

                await safeReply(
                    interaction,
                    {
                        embeds: [
                            new EmbedBuilder()
                                .setTitle(title)
                                .setDescription(
                                    `[🌐 Ouvrir](${url})`
                                )
                                .setColor(
                                    0x5865F2
                                )
                        ]
                    }
                );

                return;
            }

            // ==========================================
            // /panel
            // ==========================================

            if (command === 'panel') {
                const channel =
                    await client.channels.fetch(
                        PANEL_CHANNEL_ID
                    );

                if (
                    !channel ||
                    !channel.isTextBased()
                ) {
                    await safeReply(
                        interaction,
                        {
                            content:
                                '❌ Salon panneau introuvable.',
                            flags:
                                MessageFlags.Ephemeral
                        }
                    );

                    return;
                }

                await channel.send(
                    createPanel()
                );

                await safeReply(
                    interaction,
                    {
                        content:
                            '✅ Panneau envoyé.',
                        flags:
                            MessageFlags.Ephemeral
                    }
                );

                return;
            }

            // ==========================================
            // /say
            // ==========================================

            if (command === 'say') {
                const text =
                    interaction.options.getString(
                        'texte'
                    );

                await interaction.channel.send(
                    text
                );

                await safeReply(
                    interaction,
                    {
                        content:
                            '✅ Message envoyé.',
                        flags:
                            MessageFlags.Ephemeral
                    }
                );

                return;
            }

            // ==========================================
            // /kick
            // ==========================================

            if (command === 'kick') {
                const user =
                    interaction.options.getUser(
                        'membre'
                    );

                const member =
                    await interaction.guild.members
                        .fetch(user.id)
                        .catch(
                            () => null
                        );

                if (
                    !member ||
                    !member.kickable
                ) {
                    await safeReply(
                        interaction,
                        {
                            content:
                                '❌ Je ne peux pas expulser ce membre.',
                            flags:
                                MessageFlags.Ephemeral
                        }
                    );

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

                await safeReply(
                    interaction,
                    `👢 **${user.tag}** a été expulsé.\nRaison : ${reason}`
                );

                return;
            }

            // ==========================================
            // /ban
            // ==========================================

            if (command === 'ban') {
                const user =
                    interaction.options.getUser(
                        'membre'
                    );

                const member =
                    await interaction.guild.members
                        .fetch(user.id)
                        .catch(
                            () => null
                        );

                if (
                    member &&
                    !member.bannable
                ) {
                    await safeReply(
                        interaction,
                        {
                            content:
                                '❌ Je ne peux pas bannir ce membre.',
                            flags:
                                MessageFlags.Ephemeral
                        }
                    );

                    return;
                }

                const reason =
                    interaction.options.getString(
                        'raison'
                    ) ||
                    'Aucune raison';

                await interaction.guild.members.ban(
                    user.id,
                    { reason }
                );

                await safeReply(
                    interaction,
                    `🔨 **${user.tag}** a été banni.\nRaison : ${reason}`
                );

                return;
            }

            // ==========================================
            // /timeout
            // ==========================================

            if (command === 'timeout') {
                const user =
                    interaction.options.getUser(
                        'membre'
                    );

                const member =
                    await interaction.guild.members
                        .fetch(user.id)
                        .catch(
                            () => null
                        );

                if (
                    !member ||
                    !member.moderatable
                ) {
                    await safeReply(
                        interaction,
                        {
                            content:
                                '❌ Je ne peux pas timeout ce membre.',
                            flags:
                                MessageFlags.Ephemeral
                        }
                    );

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

                await safeReply(
                    interaction,
                    `⏱️ **${user.tag}** est timeout pendant **${seconds} seconde(s)**.`
                );

                return;
            }

            // ==========================================
            // /untimeout
            // ==========================================

            if (
                command === 'untimeout'
            ) {
                const user =
                    interaction.options.getUser(
                        'membre'
                    );

                const member =
                    await interaction.guild.members
                        .fetch(user.id)
                        .catch(
                            () => null
                        );

                if (
                    !member ||
                    !member.moderatable
                ) {
                    await safeReply(
                        interaction,
                        {
                            content:
                                '❌ Je ne peux pas modifier ce membre.',
                            flags:
                                MessageFlags.Ephemeral
                        }
                    );

                    return;
                }

                await member.timeout(
                    null,
                    'Timeout retiré'
                );

                await safeReply(
                    interaction,
                    `✅ Timeout retiré pour **${user.tag}**.`
                );

                return;
            }

            // ==========================================
            // /8ball
            // ==========================================

            if (command === '8ball') {
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

                await safeReply(
                    interaction,
                    `🎱 **${question}**\n→ ${answer}`
                );

                return;
            }

            // ==========================================
            // /coinflip
            // ==========================================

            if (command === 'coinflip') {
                await safeReply(
                    interaction,
                    `🪙 **${
                        Math.random() < 0.5
                            ? 'Pile'
                            : 'Face'
                    }**`
                );

                return;
            }

            // ==========================================
            // /roll
            // ==========================================

            if (command === 'roll') {
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

                await safeReply(
                    interaction,
                    `🎲 **${result}** / ${max}`
                );

                return;
            }

            // ==========================================
            // /random
            // ==========================================

            if (command === 'random') {
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

                await safeReply(
                    interaction,
                    `🎯 **${result}**`
                );

                return;
            }

            // ==========================================
            // /clear10 -> /clear100
            // ==========================================

            const clearMatch =
                command.match(
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
                    await safeReply(
                        interaction,
                        {
                            content:
                                '❌ Tu dois avoir **Gérer les messages**.',
                            flags:
                                MessageFlags.Ephemeral
                        }
                    );

                    return;
                }

                const botMember =
                    interaction.guild
                        .members.me;

                if (
                    !botMember?.permissions.has(
                        PermissionFlagsBits.ManageMessages
                    )
                ) {
                    await safeReply(
                        interaction,
                        {
                            content:
                                '❌ Je dois avoir **Gérer les messages**.',
                            flags:
                                MessageFlags.Ephemeral
                        }
                    );

                    return;
                }

                if (
                    !interaction.channel ||
                    !interaction.channel.isTextBased()
                ) {
                    await safeReply(
                        interaction,
                        {
                            content:
                                '❌ Cette commande ne fonctionne pas ici.',
                            flags:
                                MessageFlags.Ephemeral
                        }
                    );

                    return;
                }

                const deleted =
                    await interaction.channel.bulkDelete(
                        amount,
                        true
                    );

                await safeReply(
                    interaction,
                    {
                        content:
                            `🧹 **${deleted.size}** message(s) supprimé(s).`,
                        flags:
                            MessageFlags.Ephemeral
                    }
                );

                return;
            }

        } catch (error) {
            console.error(
                '❌ Interaction error :',
                error
            );

            // IMPORTANT :
            // si Discord dit que l'interaction est déjà traitée
            // ou expirée, on ne tente surtout pas une deuxième réponse.
            if (
                error?.code === 40060 ||
                error?.code === 10062 ||
                error?.status === 404
            ) {
                return;
            }

            try {
                if (
                    interaction.deferred ||
                    interaction.replied
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
            } catch (replyError) {
                if (
                    !isInteractionGone(
                        replyError
                    )
                ) {
                    console.error(
                        '❌ Impossible de répondre :',
                        replyError
                    );
                }
            }
        }
    }
);

// ==================================================
// ERREURS PROCESS
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
        '❌ TOKEN absent.'
    );

    process.exit(1);
}

if (!process.env.GEMINI_API_KEY) {
    console.warn(
        '⚠️ GEMINI_API_KEY absente.'
    );
}

// ==================================================
// LOGIN
// ==================================================

client.login(
    process.env.TOKEN
);
