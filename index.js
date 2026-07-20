// ╔══════════════════════════════════════════╗
// ║      ⌞ Beatrice [Re:zero] Bot ⌝          ║
// ║   Bot de WhatsApp con Baileys (Rei-Bot)  ║
// ╚══════════════════════════════════════════╝

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  downloadContentFromMessage,
  getContentType,
  generateWAMessageFromContent,
  proto,
} = require("@whiskeysockets/baileys");

const axios    = require("axios");
const fs       = require("fs");
const path     = require("path");
const readline = require("readline");
const { execFile, execFileSync } = require("child_process");

// ─── Red de seguridad global ───────────────────────────────────────────────
// Sin esto, CUALQUIER error que no esté atrapado con try/catch (por ejemplo,
// un await sin try/catch dentro del callback de un comando) mata el proceso
// entero de Node y el bot se apaga por completo, en vez de solo fallar ese
// comando puntual. Con esto, esos errores solo se registran en consola y el
// bot sigue funcionando con normalidad para todo lo demás.
process.on("uncaughtException", (err) => {
  console.error("[UNCAUGHT EXCEPTION] El bot casi se cae por esto, pero se atrapó a tiempo:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[UNHANDLED REJECTION] El bot casi se cae por esto, pero se atrapó a tiempo:", reason);
});
const { Boom } = require("@hapi/boom");
const ffmpeg   = require("fluent-ffmpeg");
const crypto   = require("crypto");
// node-webpmux se usa para inyectar el EXIF (nombre/autor) en los stickers.
// Si no está instalado, los stickers se siguen creando pero sin esa metadata.
let webpmux = null;
try {
  webpmux = require("node-webpmux");
} catch {
  console.warn("[STICKERS] node-webpmux no está instalado, los stickers no tendrán descripción/autor. Instálalo con: npm install node-webpmux");
}
// ─── Configuración ────────────────────────────────────────────────────────────
const CONFIG = {
  prefix:    "#",
  ownerName: "MoozOut",
  botName:  "Beatrice (^w^)",
  version:  "¡Kashira!",
};

// Número (sin @s.whatsapp.net) de la cuenta con la que el bot inició sesión.
// Se llena solo al conectar (evento "open"). Ese número ES el owner del bot
// en todo sentido: no hay ningún número hardcodeado en el código.
let BOT_NUMBER = null;

// Cuánto tiempo se le da a un grupo nuevo para hacer admin al bot antes de que se salga solo.
const ADMIN_GRACE_MS = 5 * 60 * 1000;

const DEFAULT_WELCOME_MSG = "[ (づ｡◕‿‿◕｡)づ ] ¡Hola, {user}! Bienvenido/a a *{grupo}* kashira~\nEspero que la pases genial, no olvides leer las reglas y presentarte con el grupo (*^.^*)";
const DEFAULT_BYE_MSG = "[ (._.)ﾉ ] {user} ha salido de *{grupo}* kashira...\n¡Gracias por haber sido parte del grupo, te deseamos lo mejor! (T_T)/";
const DEFAULT_BIRTHDAY_MSG = "[ (๑˃ᴗ˂)ﻭ ] ¡Feliz cumpleaños, {user}! (ノ◕ヮ◕)ノ*:・゚✧\n¡Todo *{grupo}* te desea lo mejor en tu día kashira! Que cumplas muchos más~ (hoy cumples {edad} años)";

// Metadata que se inyecta en el EXIF de cada sticker creado con #s.
const STICKER_META = {
  discord: "https://discord.gg/m65MUCesZ",
  credit:  "Beatrice Bot",
  divider: "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈",
};

// Construye el EXIF de WhatsApp para stickers (pack name = descripción + grupo, author = crédito decorado).
// packname: descripción opcional que puso el usuario después de #s.
// authorName: nombre de quien creó el sticker.
// groupName: nombre del grupo donde se creó (null si es chat privado).
async function writeStickerExif(webpBuffer, packname, authorName, groupName) {
  if (!webpmux) return webpBuffer;
  try {
    const img = new webpmux.Image();
    await img.load(webpBuffer);

    const packLines = [`🔖 ${packname && packname.trim() ? packname.trim() : "Sticker"}`];
    if (groupName) packLines.push(`🗂️ ${groupName}`);

    const authorLines = [
      `✒️ Creado por: ${authorName}`,
      STICKER_META.divider,
      `💽 Creado con: ${STICKER_META.credit}`,
      `🛰️ ${STICKER_META.discord}`,
    ];

    const json = {
      "sticker-pack-id": "beatrice-bot-" + Date.now(),
      "sticker-pack-name": packLines.join("\n"),
      "sticker-pack-publisher": authorLines.join("\n"),
      "emojis": [""],
    };

    const exifAttr = Buffer.from([
      0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
      0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
    ]);
    const jsonBuff = Buffer.from(JSON.stringify(json), "utf-8");
    const exif = Buffer.concat([exifAttr, jsonBuff]);
    exif.writeUIntLE(jsonBuff.length, 14, 4);

    img.exif = exif;
    return await img.save(null);
  } catch (e) {
    console.error("[STICKERS] No se pudo escribir el EXIF:", e.message);
    return webpBuffer;
  }
}

// Categorías que los admins pueden activar/desactivar por grupo con #on / #off.
// ("admin" y "owner" nunca se incluyen aquí: esos comandos jamás se pueden desactivar.)
const VALID_CATEGORIES = ["descargas", "utilidades", "welcome", "perfil", "juegos", "economia", "editor", "animeactions"];

// Interruptores de moderación automática, activables con #on/#off igual que antilink.
// dbKey es dónde se guarda el estado por grupo en la DB (db[dbKey][groupId] = true/false).
const ANTI_TOGGLES = {
  antiaudio:   { dbKey: "antiaudio",   label: "Antiaudio",   desc: "Se borrarán las notas de voz y audios que envíen los no-admins." },
  antisticker: { dbKey: "antisticker", label: "Antisticker",  desc: "Se borrarán los stickers que envíen los no-admins." },
  antiimage:   { dbKey: "antiimage",   label: "Antiimagen",  desc: "Se borrarán las imágenes que envíen los no-admins." },
  antivideo:   { dbKey: "antivideo",   label: "Antivideo",    desc: "Se borrarán los videos que envíen los no-admins." },
  antispam:    { dbKey: "antispam",    label: "Antispam",     desc: "Se borrarán y advertirán mensajes repetidos enviados muy seguido por un no-admin." },
  antibot:     { dbKey: "antibot",     label: "Antibot",      desc: "Se borrarán mensajes con prefijos de otros bots (., !, /, etc.) para evitar choques entre bots." },
  onlyadmins:  { dbKey: "onlyAdmins",  label: "Onlyadmins",   desc: "Solo los administradores podrán usar los comandos del bot en este grupo (excepto #menu, #bi, #on y #off)." },
};

const CATEGORY_MAP = {
  // descargas
  tt: "descargas", fb: "descargas", yta: "descargas", ytv: "descargas", pin: "descargas", lyrics: "descargas",
  // utilidades
  s: "utilidades", p: "utilidades", toimg: "utilidades", calc: "utilidades", tr: "utilidades", qr: "utilidades",
  timer: "utilidades", poll: "utilidades", define: "utilidades", short: "utilidades",
  encrypt: "utilidades", decrypt: "utilidades",
  bug: "utilidades", suggest: "utilidades",
  // admin
  tag: "admin", prom: "admin", dem: "admin", desc: "admin", gname: "admin", gi: "admin",
  k: "admin", del: "admin", warn: "admin", seew: "admin", delwarn: "admin", lock: "admin", warnlimit: "admin",
  gpfp: "admin",
  // welcome / despedidas
  wel: "welcome", setwel: "welcome", welimg: "welcome", twel: "welcome",
  bye: "welcome", setbye: "welcome", byeimg: "welcome", tbye: "welcome",
  birthday: "welcome", setbirthday: "welcome", birthdayimg: "welcome", tbirthday: "welcome",
  // perfil
  createprofile: "perfil", profile: "perfil", setname: "perfil", setgender: "perfil",
  profiledesc: "perfil", profilepfp: "perfil", setbirth: "perfil", setprofile: "perfil",
  favorite: "perfil",
  stats: "perfil", marry: "perfil", divorce: "perfil", level: "perfil",
  adoptpet: "perfil", pet: "perfil", releasepet: "perfil", renamepet: "perfil", feedpet: "perfil", playpet: "perfil",
  preg: "perfil", pvsp: "perfil", acceptvs: "perfil", renamekid: "perfil", nick: "perfil", nicks: "perfil", couples: "perfil", afk: "perfil",
  // juegos
  ship: "juegos", vs: "juegos", best: "juegos", rat: "juegos", simp: "juegos", iq: "juegos",
  eightball: "juegos", trivia: "juegos", math: "juegos", wouldyourather: "juegos", owoify: "juegos",
  gay: "juegos", lesbian: "juegos", bisexual: "juegos", freaky: "juegos", otaku: "juegos", funny: "juegos",
  // admin
  admins: "admin", invitelink: "admin",
  revoke: "admin", setrules: "admin", rules: "admin", clearwarns: "admin",
  // economía
  work: "economia", crime: "economia", daily: "economia", deposit: "economia", withdraw: "economia", steal: "economia", grind: "economia",
  dungeon: "economia", ritual: "economia", adventure: "economia", slut: "economia",
  bal: "economia", cf: "economia", rt: "economia", pay: "economia", top: "economia", einfo: "economia",
  slots: "economia", dice: "economia",
  shop: "economia", buy: "economia",
  equip: "economia", unequip: "economia", inv: "economia", perks: "economia", customtitle: "economia",
  mine: "economia", fish: "economia", sell: "economia", craft: "economia",
  keys: "economia", mats: "economia", tools: "economia", zones: "economia",
  // editor multimedia (ffmpeg)
  tomp3: "editor",
  comp: "editor",
  blur: "editor", sharpen: "editor", invert: "editor", reverse: "editor",
};

// ─── Acciones de anime: conversión a mp4 + caché ──────────────────────────────
// OtakuGifs entrega .gif real, pero WhatsApp solo reproduce como "gif animado"
// si se envía como video (mp4) con gifPlayback:true; un .gif crudo mandado como
// video sale como imagen estática/borrosa. Por eso convertimos con ffmpeg.
// Además cacheamos el resultado en disco por URL: como cada reacción tiene un
// pool pequeño de gifs, es muy probable repetir el mismo gif, y así la 2da vez
// se envía casi al instante sin descargar ni convertir de nuevo.
const ANIME_CACHE_DIR = path.join(__dirname, "anime_cache");
if (!fs.existsSync(ANIME_CACHE_DIR)) fs.mkdirSync(ANIME_CACHE_DIR, { recursive: true });

// Límite de tamaño para la caché: si se pasa, se borran los archivos más
// antiguos (por fecha de modificación) hasta volver a estar por debajo.
const ANIME_CACHE_MAX_BYTES = 500 * 1024 * 1024; // 500 MB

function enforceAnimeCacheLimit() {
  try {
    const files = fs.readdirSync(ANIME_CACHE_DIR).map(f => {
      const full = path.join(ANIME_CACHE_DIR, f);
      const stat = fs.statSync(full);
      return { full, size: stat.size, mtime: stat.mtimeMs };
    });
    let total = files.reduce((sum, f) => sum + f.size, 0);
    if (total <= ANIME_CACHE_MAX_BYTES) return;

    files.sort((a, b) => a.mtime - b.mtime); // más antiguos primero
    for (const f of files) {
      if (total <= ANIME_CACHE_MAX_BYTES) break;
      fs.unlinkSync(f.full);
      total -= f.size;
    }
  } catch (e) {
    console.error("[ANIME CACHE] Error al aplicar el límite:", e.message);
  }
}

function animeCachePath(url) {
  const hash = crypto.createHash("md5").update(url).digest("hex");
  return path.join(ANIME_CACHE_DIR, `${hash}.mp4`);
}

async function getAnimeGifMp4(url) {
  const cachePath = animeCachePath(url);
  if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath);

  const imgResponse = await axios.get(url, { responseType: "arraybuffer" });
  const gifBuffer = Buffer.from(imgResponse.data, "binary");

  const mp4Buffer = await runFfmpeg(gifBuffer, ".gif", ".mp4", (cmd) => {
    cmd.videoCodec("libx264").outputOptions([
      "-pix_fmt yuv420p",
      "-movflags +faststart",
      "-vf scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-preset ultrafast",
      "-crf 28",
    ]);
  });

  try { fs.writeFileSync(cachePath, mp4Buffer); } catch (e) { /* no crítico */ }
  enforceAnimeCacheLimit();
  return mp4Buffer;
}

// ─── Acciones de anime (OtakuGifs) ────────────────────────────────────────────
// Cada fila: [comando, etiqueta para el menú, descripción corta, frase solo (reflexiva),
// frase en pareja (verbo transitivo que se combina con "@u1 <frase> @u2")].
// El gif en sí siempre sale del mismo pool de OtakuGifs (la API no distingue
// "solo" de "en pareja"); lo que cambia entre un modo y otro es solo el texto.
const ANIME_ACTIONS = {};
[
  ["airkiss", "Beso volado", "Envía un beso al aire hacia alguien", "manda un beso al aire", "le manda un beso volado a"],
  ["angrystare", "Mirada de enojo", "Lanza una mirada de enojo", "mira con enojo a la nada", "mira con enojo a"],
  ["bite", "Mordida", "Muerde a alguien (o se muerde solo)", "se muerde el labio", "muerde a"],
  ["bleh", "Sacar la lengua", "Saca la lengua en burla", "saca la lengua al espejo", "le saca la lengua a"],
  ["blush", "Sonrojo", "Se sonroja de vergüenza", "se sonroja solo", "se sonroja al ver a"],
  ["brofist", "Choque de puños", "Choca los puños en señal de camaradería", "choca puños con el aire", "choca puños con"],
  ["celebrate", "Celebración", "Celebra con mucha emoción", "celebra solo", "celebra junto a"],
  ["cheers", "Brindis", "Levanta su copa para brindar", "brinda solo", "brinda junto a"],
  ["clap", "Aplauso", "Aplaude con entusiasmo", "aplaude solo", "le aplaude a"],
  ["confused", "Confusión", "Se muestra confundido", "está muy confundido", "está confundido por"],
  ["cool", "Actitud cool", "Actúa con mucha onda", "se pone lentes y actúa cool", "se hace el cool frente a"],
  ["cry", "Llanto", "Rompe en llanto", "llora solo", "llora en el hombro de"],
  ["cuddle", "Arrumaco", "Se acurruca cariñosamente", "se abraza a una almohada", "se acurruca con"],
  ["dance", "Baile", "Se pone a bailar", "baila solo", "baila con"],
  ["drool", "Babear", "Babea de gusto", "babea solo", "babea al ver a"],
  ["evillaugh", "Risa malvada", "Suelta una carcajada villana", "suelta una risa malvada", "se ríe malignamente de"],
  ["facepalm", "Facepalm", "Se cubre la cara de vergüenza ajena", "se golpea la cara con la mano", "hace facepalm por culpa de"],
  ["handhold", "Tomarse de la mano", "Toma la mano de alguien", "se toma su propia mano, qué triste", "le toma la mano a"],
  ["happy", "Felicidad", "Se muestra muy feliz", "está muy feliz", "es feliz gracias a"],
  ["headbang", "Headbang", "Sacude la cabeza al ritmo de la música", "sacude la cabeza al ritmo de la música", "hace headbang junto a"],
  ["hug", "Abrazo", "Da un abrazo cálido", "se abraza a sí mismo", "abraza a"],
  ["huh", "Duda", "Reacciona confundido con un 'huh?'", "no entiende nada", "no entiende lo que dice"],
  ["kiss", "Beso", "Da un beso", "manda un beso al espejo", "besa a"],
  ["laugh", "Risa", "Se ríe a carcajadas", "se ríe solo", "se ríe con"],
  ["lick", "Lamer", "Lame algo (o a alguien)", "se lame los labios", "lame a"],
  ["love", "Amor", "Muestra mucho cariño", "está enamorado de la vida", "está enamorado de"],
  ["mad", "Enojo", "Se pone furioso", "está furioso", "está furioso con"],
  ["nervous", "Nervios", "Se muestra nervioso", "está muy nervioso", "se pone nervioso frente a"],
  ["no", "Negación", "Dice claramente que no", "se niega a todo", "le dice que no a"],
  ["nom", "Comer", "Come algo con muchas ganas", "come felizmente", "le quita comida a"],
  ["nosebleed", "Sangrado nasal", "Le sangra la nariz de la impresión", "le sangra la nariz de la impresión", "le sangra la nariz al ver a"],
  ["nuzzle", "Acurrucarse (nariz)", "Se frota cariñosamente contra alguien", "se acurruca contra su almohada", "se acurruca cariñosamente contra"],
  ["nyah", "Gesto gatuno", "Hace un gesto tierno tipo gato", "hace un gesto gatuno, nyah~", "le hace nyah~ a"],
  ["pat", "Palmadita", "Da palmaditas en la cabeza", "se da palmaditas a sí mismo", "le da palmaditas a"],
  ["peek", "Espiar", "Espía disimuladamente", "espía detrás de la puerta", "espía a"],
  ["pinch", "Pellizco", "Da un pellizco", "se pellizca para comprobar que no sueña", "pellizca a"],
  ["poke", "Toque", "Da un toquecito para llamar la atención", "se toca a sí mismo, qué raro", "le da un toquecito a"],
  ["pout", "Puchero", "Hace un puchero de enojo", "hace un puchero", "le hace un puchero a"],
  ["punch", "Puñetazo", "Da un puñetazo", "se golpea a sí mismo, auch", "le da un puñetazo a"],
  ["roll", "Ojos en blanco", "Pone los ojos en blanco", "pone los ojos en blanco", "pone los ojos en blanco por"],
  ["run", "Correr", "Sale corriendo", "sale corriendo solo", "corre hacia"],
  ["sad", "Tristeza", "Se muestra triste", "está muy triste", "está triste por"],
  ["scared", "Miedo", "Se muestra asustado", "está aterrado", "le tiene miedo a"],
  ["shout", "Grito", "Pega un grito", "grita solo", "le grita a"],
  ["shrug", "Encogerse de hombros", "Se encoge de hombros sin saber qué decir", "se encoge de hombros", "se encoge de hombros ante"],
  ["shy", "Timidez", "Se muestra tímido", "está muy tímido", "se pone tímido frente a"],
  ["sigh", "Suspiro", "Suelta un suspiro", "suspira profundamente", "suspira por"],
  ["sing", "Cantar", "Se pone a cantar", "canta solo", "le canta a"],
  ["sip", "Sorbo", "Toma un sorbo de su bebida", "toma un sorbo de su bebida", "toma un sorbo mirando fijamente a"],
  ["slap", "Cachetada", "Da una cachetada", "se da una cachetada a sí mismo", "le da una cachetada a"],
  ["sleep", "Dormir", "Se queda profundamente dormido", "se queda dormido", "se duerme sobre"],
  ["slowclap", "Aplauso lento", "Aplaude lento en forma irónica", "aplaude lentamente, irónico", "le da un aplauso lento e irónico a"],
  ["smack", "Golpe", "Da un golpe seco", "se golpea a sí mismo sin querer", "le da un golpe a"],
  ["smile", "Sonrisa", "Regala una sonrisa", "sonríe para sí mismo", "le sonríe a"],
  ["smug", "Sonrisa engreída", "Pone cara de superioridad", "pone cara de superioridad", "pone cara de superioridad frente a"],
  ["sneeze", "Estornudo", "Suelta un estornudo", "estornuda fuerte", "le estornuda encima a"],
  ["sorry", "Disculpa", "Pide disculpas", "se disculpa consigo mismo", "le pide perdón a"],
  ["stare", "Mirada fija", "Se queda mirando fijamente", "se queda mirando a la nada", "se queda mirando fijamente a"],
  ["stop", "Alto", "Pide que se detengan", "se detiene a sí mismo", "le grita que se detenga a"],
  ["surprised", "Sorpresa", "Se muestra muy sorprendido", "se sorprende de la nada", "se sorprende al ver a"],
  ["sweat", "Sudor nervioso", "Suda frío por los nervios", "suda frío de los nervios", "suda frío frente a"],
  ["thumbsup", "Pulgar arriba", "Da el visto bueno con el pulgar", "se da su propio visto bueno", "le da un pulgar arriba a"],
  ["tickle", "Cosquillas", "Hace cosquillas sin piedad", "se hace cosquillas él mismo", "le hace cosquillas a"],
  ["tired", "Cansancio", "Se muestra muy cansado", "está agotado", "está agotado de"],
  ["wave", "Saludo", "Saluda con la mano", "saluda al aire", "le saluda con la mano a"],
  ["wink", "Guiño", "Guiña el ojo con complicidad", "se guiña el ojo frente al espejo", "le guiña el ojo a"],
  ["woah", "Asombro", "Reacciona con un 'woah' de asombro", "se queda con la boca abierta, woah", "se queda asombrado al ver a"],
  ["yawn", "Bostezo", "Suelta un gran bostezo", "bosteza de sueño", "bosteza en la cara de"],
  ["yay", "Alegría", "Celebra con emoción gritando yay", "celebra gritando yay solo", "celebra gritando yay junto a"],
  ["yes", "Afirmación", "Dice que sí, muy convencido", "se da la razón a sí mismo", "le da la razón a"],
].forEach(([key, label, desc, solo, pair]) => {
  ANIME_ACTIONS[key] = { reaction: key, label, desc, solo, pair };
});

// Registra automáticamente cada acción en CATEGORY_MAP bajo "animeactions",
// así #on/#off animeactions las prende/apaga todas juntas.
for (const key of Object.keys(ANIME_ACTIONS)) CATEGORY_MAP[key] = "animeactions";

// 3 variantes de frase para cuando el comando se usa solo (sin mencionar a nadie)
// y 3 para cuando se usa en pareja (con mención). {u1}/{u2} son las menciones,
// {verb} es la frase solo/pair de cada acción en ANIME_ACTIONS.
const ANIME_SOLO_TEMPLATES = [
  "{u1} {verb} kashira...",
  "Parece que {u1} {verb}~",
  "{u1} {verb}, nadie más por aquí kashira (._.)",
];
const ANIME_PAIR_TEMPLATES = [
  "{u1} {verb} {u2} kashira~",
  "{u1} {verb} {u2}, mira nada más~",
  "¡{u1} {verb} {u2} kashira! (>w<)",
];

// Igual que buildAnimeMenuText(), pero en el formato usado dentro de MENU.main
// (backtick + '#comando' + '> descripción'), para listar las 70 acciones completas ahí también.
function buildAnimeMainMenuText() {
  return Object.values(ANIME_ACTIONS)
    .map(a => ` \`#${a.reaction} [@usuario]\`\n  > ${a.desc}`)
    .join("\n\n");
}

// Construye el texto del submenú "#menu animeactions" a partir de ANIME_ACTIONS,
// para no tener que escribir 70 bloques de comando/descripción a mano.
function buildAnimeMenuText() {
  const header = `*⌞ Categoría: Acciones de Anime ⌝*\n(gifs cortesía de OtakuGifs — usa el comando solo para hacerlo contigo mismo, o menciona a alguien para hacerlo en pareja)\n━━━━━━━━━━━━━━━━\n`;
  const body = Object.values(ANIME_ACTIONS)
    .map(a => `*Comando:* #${a.reaction} [@usuario]\n*Descripción:* ${a.desc} kashira.`)
    .join("\n──\n");
  return header + body + "\n━━━━━━━━━━━━━━━━";
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function sendText(sock, jid, text, quotedMsg) {
  let finalText = text;
  try {
    if (quotedMsg && jid?.endsWith("@g.us")) {
      const qSenderRaw = quotedMsg.key?.participant || quotedMsg.key?.remoteJid;
      const qNum = resolveToPN(qSenderRaw)?.split("@")[0]?.split(":")[0];
      if (qNum) {
        const db = loadDB();
        const eff = db.secretEffects?.[jid]?.[qNum];
        if (eff?.curseword && Date.now() < eff.curseword.until) {
          finalText = `${text} ${eff.curseword.word}`;
        }
      }
    }
  } catch (e) {
    // Nunca debe tronar un envío de texto normal por culpa de esta revisión opcional.
  }
  await sock.sendMessage(jid, { text: finalText }, { quoted: quotedMsg });
}

// Busca y envía la letra de una canción dado artista + título, usando lyrics.ovh (gratis, sin API key).
async function sendLyricsResult(sock, jid, quotedMsg, artist, title) {
  try {
    const res = await axios.get(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
    const rawLyrics = (res.data?.lyrics || "").trim();
    if (!rawLyrics) throw new Error("sin letra disponible");

    const header = `*⌞ ${title} ⌝*\n(o^-')b *Artista:* ${artist}\n━━━━━━━━━━━━━━━━\n\n`;
    const full = header + rawLyrics;

    // WhatsApp corta mensajes muy largos, así que partimos en trozos si hace falta.
    const MAX_LEN = 3500;
    if (full.length <= MAX_LEN) {
      await sock.sendMessage(jid, { text: full }, { quoted: quotedMsg });
    } else {
      await sock.sendMessage(jid, { text: header + rawLyrics.slice(0, MAX_LEN - header.length) }, { quoted: quotedMsg });
      for (let i = MAX_LEN - header.length; i < rawLyrics.length; i += MAX_LEN) {
        await sock.sendMessage(jid, { text: rawLyrics.slice(i, i + MAX_LEN) });
      }
    }
  } catch (e) {
    await sendText(sock, jid, `[ ;﹏; ] No pude encontrar la letra de *${title}* de *${artist}* kashira.`, quotedMsg);
  }
}

async function downloadMedia(message, type) {
  const stream = await downloadContentFromMessage(message, type);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Sube una imagen a catbox.moe (host gratuito, sin necesidad de API key) y devuelve
// la URL pública. Se usa para que las fotos de perfil personalizadas (#profilepfp) NO
// ocupen espacio en el disco del servidor: en vez de guardar el archivo localmente,
// solo se guarda esta URL en la base de datos.
async function uploadToCatbox(buffer, filename) {
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("fileToUpload", new Blob([buffer]), filename);

  const res = await fetch("https://catbox.moe/user/api.php", { method: "POST", body: form });
  const text = (await res.text()).trim();
  if (!text.startsWith("http")) throw new Error("catbox.moe no devolvió una URL válida: " + text);
  return text;
}

// Genera una ruta temporal única por llamada (no por milisegundo), para que dos usuarios
// usando el mismo comando (sticker, toimg, pfp, descargas) al mismo tiempo no se pisen
// el archivo temporal entre sí. Antes se usaba solo Date.now(), que puede repetirse.
function uniqueTmpPath(prefix, ext = "") {
  const id = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
  return path.join(__dirname, `${prefix}_${id}${ext}`);
}

// mediaExt: extensión real del medio de entrada (".webp" para stickers, ".jpg" para
// imágenes). Sin esto, el archivo temporal no tenía extensión y ffmpeg podía fallar
// al identificar el demuxer correcto para stickers ANIMADOS (webp con varios frames):
// el output es un solo .jpg, y sin forzar "-frames:v 1" ffmpeg intentaba procesar
// todos los frames de la animación contra un muxer de una sola imagen y tronaba
// de inmediato (frame=0, "Conversion failed"). Los stickers estáticos sí funcionaban
// porque solo tienen 1 frame, por eso el bug parecía intermitente.
function convertToJpgWithFfmpeg(inputBuffer, mediaExt = "") {
  return new Promise((resolve, reject) => {
    const tmpIn = uniqueTmpPath("tmp_conv_in", mediaExt);
    const tmpOut = uniqueTmpPath("tmp_conv_out", ".jpg");
    
    fs.writeFileSync(tmpIn, inputBuffer);
    
    ffmpeg(tmpIn)
      .outputOptions(["-frames:v", "1"])
      .output(tmpOut)
      .on("end", () => {
        try {
          const resBuffer = fs.readFileSync(tmpOut);
          if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
          if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
          resolve(resBuffer);
        } catch (err) {
          reject(err);
        }
      })
      .on("error", (err) => {
        if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
        if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
        reject(err);
      })
      .run();
  });
}

// ─── Helpers para el editor multimedia (#comp, #acelerar, etc.) ──────────
function getMediaFromMsg(msg, quotedContext) {
  // unwrapMessage() por si el medio directo viene como "ver una vez"/efímero.
  const m = unwrapMessage(msg.message);
  const v = m?.videoMessage || quotedContext?.videoMessage;
  const a = m?.audioMessage || quotedContext?.audioMessage;
  const i = m?.imageMessage || quotedContext?.imageMessage;
  const st = m?.stickerMessage || quotedContext?.stickerMessage;
  if (v) return { type: "video", node: v };
  if (a) return { type: "audio", node: a };
  if (i) return { type: "image", node: i };
  if (st) return { type: "sticker", node: st };
  return null;
}

// Corre un comando ffmpeg genérico: escribe el buffer de entrada a un archivo
// temporal, aplica lo que se configure en buildFn(cmd), y devuelve el buffer
// de salida. Limpia los temporales pase lo que pase.
function runFfmpeg(inputBuffer, inExt, outExt, buildFn) {
  return new Promise((resolve, reject) => {
    const tmpIn = uniqueTmpPath("edit_in", inExt);
    const tmpOut = uniqueTmpPath("edit_out", outExt);
    fs.writeFileSync(tmpIn, inputBuffer);

    const cmd = ffmpeg(tmpIn);
    buildFn(cmd);

    cmd
      .output(tmpOut)
      .on("end", () => {
        try {
          const buf = fs.readFileSync(tmpOut);
          [tmpIn, tmpOut].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
          resolve(buf);
        } catch (err) {
          reject(err);
        }
      })
      .on("error", (err) => {
        [tmpIn, tmpOut].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
        reject(err);
      })
      .run();
  });
}

// ─── Encriptación básica con contraseña (#encrypt / #decrypt) ──────────
// Deriva una clave AES-256 a partir de la contraseña + una sal aleatoria (scrypt),
// y guarda sal + iv + texto cifrado, todo junto en un solo string base64.
function encryptWithPassword(text, password) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, 32);

  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);

  return Buffer.concat([salt, iv, encrypted]).toString("base64");
}

function decryptWithPassword(data, password) {
  const buf = Buffer.from(data, "base64");
  if (buf.length < 32) throw new Error("Formato inválido");

  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 32);
  const encrypted = buf.subarray(32);
  const key = crypto.scryptSync(password, salt, 32);

  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  return decrypted.toString("utf8");
}

function generateProfilePicture(buffer) {
  return new Promise((resolve, reject) => {
    const tmpIn = uniqueTmpPath("pfp_in");
    const tmpOut = uniqueTmpPath("pfp_out", ".jpg");

    fs.writeFileSync(tmpIn, buffer);

    ffmpeg(tmpIn)
      .videoFilter("crop='w=min(iw,ih):h=min(iw,ih)',scale=640:640")
      .outputOptions("-vframes 1")
      .output(tmpOut)
      .on("end", () => {
        try {
          const resBuffer = fs.readFileSync(tmpOut);
          if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
          if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
          resolve(resBuffer);
        } catch (err) {
          reject(err);
        }
      })
      .on("error", (err) => {
        if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
        if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
        reject(err);
      })
      .run();
  });
}

// ─── Mapa LID → PN (se construye en tiempo real) ────────────────────────────
const lidToPn = new Map(); // "271743335854155" → "5213223783244@s.whatsapp.net"

function storeLidPn(lid, pn) {
  if (!lid || !pn) return;
  const lidNum = lid.split("@")[0].split(":")[0];
  const pnJid = pn.includes("@") ? pn.replace(/:\d+@/, "@") : pn + "@s.whatsapp.net";
  if (lidNum && pnJid) lidToPn.set(lidNum, pnJid);
}

function resolveToPN(rawJid) {
  if (!rawJid) return rawJid;
  // Ya es un PN normal
  if (rawJid.includes("@s.whatsapp.net")) return rawJid.replace(/:\d+@/, "@");
  // Es un LID, buscar en el mapa
  const lidNum = rawJid.split("@")[0].split(":")[0];
  return lidToPn.get(lidNum) || rawJid;
}

// Actualiza el mapa desde un mensaje entrante
function updateLidMapFromMsg(msg) {
  try {
    const ctx = msg.message?.extendedTextMessage?.contextInfo;
    if (ctx?.participant && ctx?.participantPn) storeLidPn(ctx.participant, ctx.participantPn);
    if (ctx?.mentionedJid) {
      // mentionedJid puede tener LIDs, pero no hay PN asociado en este campo directamente
    }
  } catch {}
}

// Actualiza el mapa desde metadatos de grupo
function updateLidMapFromMeta(meta) {
  if (!meta?.participants) return;
  for (const p of meta.participants) {
    if (p.id?.includes("@lid") && p.pn) storeLidPn(p.id, p.pn);
    if (p.id?.includes("@lid") && p.phoneNumber) storeLidPn(p.id, p.phoneNumber);
  }
}

// Devuelve el contextInfo correcto del mensaje sin importar su tipo. Antes solo se
// revisaba extendedTextMessage.contextInfo (mensaje de texto citando algo), pero si el
// comando viene como CAPTION de una imagen/video/sticker/documento mandado directo (sin
// citar), la mención de esa persona vive en imageMessage.contextInfo / videoMessage.
// contextInfo / etc., no en extendedTextMessage — y esa mención nunca se detectaba.
// Esto afectaba a cualquier comando con mención mandado junto a un adjunto directo
// (ej. #tag con un video adjuntado con el comando en su propio caption).
function getMsgContextInfo(msg) {
  const m = msg.message || {};
  return (
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.stickerMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    m.documentWithCaptionMessage?.message?.documentMessage?.contextInfo ||
    null
  );
}

function getMentionedJid(msg) {
  // Intentar obtener de contextInfo.participantPn primero (más confiable)
  const ctx = getMsgContextInfo(msg);
  if (ctx?.participantPn) return ctx.participantPn.includes("@") ? ctx.participantPn : ctx.participantPn + "@s.whatsapp.net";
  
  const quoted = ctx?.participant;
  const mentioned = ctx?.mentionedJid?.[0];
  const raw = quoted || mentioned || null;
  if (!raw) return null;
  return resolveToPN(raw);
}

// Quita cualquier "@número" del texto que corresponda a la persona mencionada/citada,
// sin importar en qué parte del texto esté (antes o después del resto de argumentos) ni
// si el bot solo conoce su LID (id interno de WhatsApp) y todavía no su PN (número real).
//
// Es necesario porque el texto crudo del mensaje trae el "@" seguido del identificador
// tal cual lo mandó WhatsApp (que puede ser el LID), mientras que "target" ya viene
// resuelto a PN gracias a resolveToPN(). Si solo se intentaba quitar "@"+PN, en grupos
// que mencionan por LID el "@LID..." se quedaba pegado al texto y sus dígitos se colaban
// como si fueran el monto, el número de advertencia o parte del motivo.
//
// Al quitar la mención sin importar su posición, esto también permite usar los comandos
// al revés (ej. "#pay 500 @user" igual que "#pay @user 500").
function stripMentionText(msg, text) {
  if (!text) return "";
  const ctx = getMsgContextInfo(msg);
  const raws = new Set();
  if (ctx?.participant) raws.add(ctx.participant);
  if (ctx?.participantPn) raws.add(ctx.participantPn);
  if (Array.isArray(ctx?.mentionedJid)) ctx.mentionedJid.forEach(j => raws.add(j));

  let clean = text;
  for (const raw of raws) {
    const digits = String(raw).split("@")[0].split(":")[0];
    if (!digits) continue;
    clean = clean.replace(new RegExp("@" + digits, "g"), "");
  }
  return clean.replace(/\s+/g, " ").trim();
}

function isOwner(jid) {
  const num = jid.split("@")[0].split(":")[0];
  return !!BOT_NUMBER && num === BOT_NUMBER;
}

// Reemplaza cualquier "@<número>" del texto crudo por "@<número real (PN)>" de esa
// misma persona, usando los mentionedJid del mensaje. Es necesario porque WhatsApp a
// veces mete el LID (identificador interno) en el texto visible en vez del número de
// teléfono real; si el texto no coincide en dígitos con lo que se manda en "mentions"
// (que siempre usamos en formato PN), WhatsApp no lo reconoce como mención y se queda
// tal cual, mostrando el LID/JID crudo en pantalla en vez de una mención bien marcada.
function normalizeMentionsInText(msg, text) {
  if (!text) return text;
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  const raws = new Set();
  if (ctx?.participant) raws.add(ctx.participant);
  if (Array.isArray(ctx?.mentionedJid)) ctx.mentionedJid.forEach(j => raws.add(j));

  let result = text;
  for (const raw of raws) {
    const rawDigits = String(raw).split("@")[0].split(":")[0];
    if (!rawDigits) continue;
    const pn = resolveToPN(raw);
    const pnDigits = pn.split("@")[0];
    if (rawDigits === pnDigits) continue; // ya coincide, nada que arreglar
    result = result.replace(new RegExp("@" + rawDigits, "g"), "@" + pnDigits);
  }
  return result;
}

// Sub-owners: usuarios promovidos con #promowner. Tienen todos los comandos de owner
// excepto #promowner y #demowner (esos siguen siendo exclusivos del owner real).
function isSubOwner(db, jid) {
  const num = jid.split("@")[0].split(":")[0];
  return (db.subOwners || []).includes(num);
}

function isOwnerLevel(db, jid) {
  return isOwner(jid) || isSubOwner(db, jid);
}

async function isAdmin(sock, groupJid, participantJid) {
  try {
    const meta = await sock.groupMetadata(groupJid);
    updateLidMapFromMeta(meta);
    const resolvedJid = resolveToPN(participantJid);
    const num = resolvedJid.split("@")[0].split(":")[0];
    return meta.participants.some(p => {
      const pResolved = resolveToPN(p.id);
      const pNum = pResolved.split("@")[0].split(":")[0];
      const pnNum = (p.pn || p.phoneNumber || "").replace(/\D/g, "");
      return (pNum === num || pnNum === num) && (p.admin === "admin" || p.admin === "superadmin");
    });
  } catch (e) {
    console.error("[ADMIN ERROR]", e.message);
    return false;
  }
}

// Ejecuta groupParticipantsUpdate (kick/promote/demote) y de verdad confirma que se
// aplicó, en vez de asumirlo. WhatsApp normalmente NO tira una excepción cuando el bot
// no es admin del grupo: solo devuelve el intento con un status distinto de "200" por
// cada persona. Antes el bot mandaba el mensaje de "listo, ya lo hice" sin fijarse en
// esto, así que si Beatrice no era admin, el mensaje de éxito salía igual aunque en
// realidad no había pasado nada.
async function safeGroupParticipantsUpdate(sock, groupJid, targetPN, action) {
  let result;
  try {
    result = await sock.groupParticipantsUpdate(groupJid, [targetPN], action);
  } catch (e) {
    return { ok: false, notBotAdmin: true };
  }
  const entry = Array.isArray(result)
    ? result.find(r => r.jid === targetPN || r.jid?.split("@")[0] === targetPN.split("@")[0])
    : null;
  const status = entry?.status ?? entry?.[0]?.status;
  if (status && String(status) !== "200") {
    // 401/403 = Beatrice no es admin (o no tiene rango suficiente); 404 = la persona ya no está en el grupo.
    return { ok: false, notBotAdmin: status !== "404" };
  }
  return { ok: true };
}

// ─── Almacenamiento simple (JSON con caché en memoria) ────────────────────────
const DB_PATH = "./data.json";
let _dbCache = null;

function loadDB() {
  if (_dbCache) return _dbCache;
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, "{}");
  _dbCache = JSON.parse(fs.readFileSync(DB_PATH));
  return _dbCache;
}

function saveDB(data) {
  _dbCache = data;
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ─── MENÚ COMPLETO ────────────────────────────────────────────────────────────
const MENU = {
  main: `*⌞ Beatrice [Re:zero] ⌝*

(*^.^*) ¡Bienvenido!

Usa *#menu [categoría]* para ver las variables kashira.

Categorías: \`economia\` \`perfil\` \`utilidades\` \`juegos\` \`animeactions\` \`descargas\` \`admin\` \`welcome\` \`owner\`
━━━━━━━━━━━━━━━━
> (o^-')b *Economía:*
 \`#w\`
  > Trabaja y gana dinero, cooldown 1 min

 \`#crime\`
  > Comete un crimen, riesgo de ganar o perder, cooldown 5 min

 \`#dungeon\` / \`#mazmorra\`
  > Explora una mazmorra, riesgo de morir y perder parte del bolsillo, cooldown 2:30 min

 \`#ritual\`
  > Haz un ritual, riesgo de ser absorbido por el portal, cooldown 4 min

 \`#adventure\` / \`#aventura\`
  > Sal de aventura, riesgo de un evento que retrasa todos tus cooldowns, cooldown 2:30 min

 \`#slut\`
  > Gana dinero rápido, riesgo de perderlo, cooldown 2:30 min

 \`#steal [@usuario]\`
  > Roba a alguien inactivo con dinero fuera del banco

 \`#d [monto|all]\`
  > Deposita dinero en tu banco, a salvo de robos (tope 10M, mejorable en #shop banco)

 \`#with [monto|all]\`
  > Retira dinero del banco

 \`#bal [@usuario]\`
  > Consulta tu saldo o el de alguien más

 \`#einfo\`
  > Muestra TODOS tus cooldowns (economía, mascota, hijos, batallas) — siempre los tuyos, nadie puede verlos por ti

 \`#grind\`
  > (requiere ventaja Grind) Corre de un jalón #w/#crime/#dungeon/#ritual/#adventure/#slut que ya no tengan cooldown

 \`#cf [monto]\`
  > Coinflip, dobla o pierde tu apuesta (cooldown 30s)

 \`#rt [monto] [rojo|negro]\`
  > Ruleta, elige color y dobla o pierde (cooldown 30s)

 \`#slots [monto]\`
  > Tragamonedas, alinea símbolos para ganar (cooldown 30s)

 \`#dice [monto]\`
  > Dados contra Beatrice, el mayor gana (cooldown 30s)

 _Tope de apuesta: 100,000,000¥ acumulados por hora entre #cf, #rt, #slots y #dice._

 \`#pay [monto] @usuario\`
  > Transfiere dinero desde tu banco

 \`#daily\`
  > Reclama tu recompensa diaria, 30k + 5k por cada día de racha

 \`#top mensajes\` / \`#top mensajes global\`
  > Top de mensajes y comandos, del grupo o de todo el bot (1 lugar por perfil)

 \`#top coins\` / \`#top coins global\`
  > Top de fortuna (wallet+banco), del grupo o de todo el bot (1 lugar por perfil)

 \`#top level\`
  > Top de niveles/XP, siempre de todo el bot

 \`#shop\`
  > Muestra la tienda de títulos, ventajas y objetos

 \`#buy [nombre]\`
  > Compra algo de la tienda con dinero del banco

 \`#customtitle [texto]\`
  > Compra un título personalizado (1M + 100k por carácter)

 \`#equip\` / \`#unequip [nombre]\`
  > Equipa o desequipa un título/objeto comprado

 \`#inv\`
  > Muestra lo que tienes equipado y en inventario

 \`#perks\`
  > Muestra tus ventajas activas

 \`#mine [zona]\`
  > Mina en una de 5 cuevas temáticas de anime, requiere pico equipado

 \`#fish [zona]\`
  > Pesca en uno de 5 lagos temáticos de anime, requiere caña equipada

 \`#sell [material] [cantidad|all]\`
  > Vende materiales de minería/pesca por dinero

 \`#craft llave [zona]\`
  > Craftea una llave de lago con materiales de minería

 \`#tools\`
  > Muestra los picos y cañas disponibles y sus stats

 \`#zones\`
  > Muestra las zonas de #mine y #fish

 \`#mats\`
  > Muestra los materiales de minería/pesca y su precio de venta

 \`#keys\`
  > Muestra el precio/receta de las llaves de mina y de lago

Usa #menu economia para ver detalles kashira!

> (o^-')b *Perfil:*
 \`#createprofile\`
  > Crea tu perfil por primera vez

 \`#profile [@usuario]\`
  > Ver tu perfil o el de alguien más, con título y objetos equipados

 \`#setname [nombre]\`
  > Cambia tu nombre en el perfil

 \`#setgender [género]\`
  > Establece tu género

 \`#profiledesc [texto]\`
  > Escribe una descripción para tu perfil

 \`#favorite [categoría] [texto]\`
  > Guarda un favorito (personaje, anime, juego, etc.), se muestra en #profile

 \`#profilepfp\`
  > Cambia la foto de tu perfil adjuntando una imagen

 \`#setbirth [dd/mm/yyyy]\`
  > Guarda tu fecha de nacimiento

 \`#setprofile pub/priv\`
  > Pon tu perfil público o privado

 \`#stats [@usuario]\`
  > Muestra estadísticas completas (comandos, mensajes, saldo, warns, títulos y objetos)

 \`#marry @usuario\`
  > Propone o acepta matrimonio

 \`#divorce\`
  > Termina el matrimonio actual

 \`#level [@usuario]\`
  > Muestra tu nivel y XP (o el de alguien más)

 \`#adoptpet [especie] [nombre]\`
  > Adopta una mascota (#adoptpet lista para ver las 50 disponibles)

 \`#pet [@usuario]\`
  > Muestra la tarjeta completa de tu mascota (o la de alguien más)

 \`#releasepet\`
  > Da tu mascota en adopción para poder adoptar otra

 \`#renamepet [nombre nuevo]\`
  > Corrige el nombre de tu mascota

 \`#feedpet\`
  > Alimenta a tu mascota (cooldown 12h)

 \`#playpet\`
  > Juega con tu mascota (cooldown 8h)

 \`#preg [nombre]\`
  > Ten un hijo con tu pareja (requiere matrimonio, cooldown 1 día, máx. 3 hijos)

 \`#renamekid [número] [nombre nuevo]\`
  > Corrige el nombre de un hijo (número según el orden que ves en #profile)

 \`#pvsp @contrincante [apuesta]\`
  > Reta la mascota de alguien más (dentro de ±5 niveles)

 \`#acceptvs @contrincante\`
  > Acepta un reto de mascotas pendiente

 \`#nick @usuario [apodo]\`
  > Ponle un apodo local (solo tú lo usas) para referirte a esa persona en comandos como #pay

 \`#nicks\`
  > Ve los apodos que te han puesto y los que tú le has puesto a otros

 \`#afk [motivo]\`
  > Marca que estás AFK; si te mencionan o responden mientras tanto, el bot avisa. Se te quita solo al volver a escribir

 \`#couples\`
  > Lista las parejas casadas activas en este grupo

Usa #menu perfil para ver detalles kashira!

>(o^-')b *Utilidades:*
 \`#invite [link]\`
  > Hace que el bot se una a un grupo/comunidad con ese link (máx. 5 usos por persona)

 \`#s [descripción opcional]\`
  > Crea un sticker a partir de una imagen o video, con tu nombre como autor

 \`#p\`
  > Calcula el ping de respuesta del bot

 \`#toimg\`
  > Transforma el sticker en imagen (JPG seguro)

 \`#calc\`
  > Calculadora: sumar, restar, multiplicar, dividir, porcentaje, exponente, raiz

 \`#tr [idioma]\`
  > Traduce el mensaje respondido. Responde con #tr ingles, español, etc.

 \`#qr [texto o link]\`
  > Genera un código QR. Responde a una imagen con #qr para leerlo.

 \`#timer [minutos] [motivo (opcional)]\`
  > Pone un temporizador y te avisa cuando termine

 \`#poll [pregunta] | [opción 1] | [opción 2] | ...\`
  > Crea una encuesta de WhatsApp

 \`#define [palabra]\`
  > Busca una definición en el diccionario de la RAE

 \`#short [link]\`
  > Acorta un link largo

 \`#encrypt [contraseña] [texto]\`
  > Encripta un texto con contraseña

 \`#decrypt [contraseña] [texto encriptado]\`
  > Recupera el texto original si la contraseña es correcta

 \`#bug [descripción]\`
  > Reporta un bug del bot

 \`#suggest [descripción]\`
  > Manda una sugerencia para el bot


> (⁠｡⁠•̀⁠ᴗ⁠-⁠)⁠✧ *Editor Multimedia:* (responde citando el audio/video/sticker/imagen)
 \`#tomp3\` / \`#toaudio\`
  > Extrae el audio de un video o nota de voz

 \`#comp\`
  > Reduce el peso de un video o imagen

 \`#blur\`
  > Desenfoca una imagen o sticker

 \`#sharpen\`
  > Aumenta la nitidez de una imagen o sticker

 \`#invert\`
  > Invierte los colores de una imagen o sticker

 \`#reverse\`
  > Invierte un video (se reproduce al revés)


> (*^.^*) *Juegos:*
 \`#ship @usuario1 @usuario2\`
  > Calcula la compatibilidad entre dos personas

 \`#vs @usuario1 @usuario2\`
  > Decide quién ganaría en una pelea

 \`#best @usuario1 @usuario2\`
  > Determina quién es mejor persona de las dos

 \`#rat @usuario\`
  > Mide qué tan rata es alguien

 \`#simp @usuario\`
  > Mide qué tan simp es alguien

 \`#iq @usuario\`
  > Mide el IQ (falso) de alguien

 \`#gay @usuario\`
  > Mide qué tan gay es alguien

 \`#lesbian @usuario\`
  > Mide qué tan lesbiana es alguien

 \`#bisexual @usuario\`
  > Mide qué tan bi es alguien

 \`#freaky @usuario\`
  > Mide qué tan freaky es alguien

 \`#otaku @usuario\`
  > Mide qué tan otaku es alguien

 \`#funny @usuario\`
  > Mide qué tan gracioso es alguien

 \`#8ball [pregunta]\`
  > Le preguntas algo a la bola 8 y responde al azar

 \`#owoify [texto]\`
  > Convierte tu texto a owo-speak (l/r→w, tartamudeo, emoticonos)

 \`#trivia [categoría opcional]\`
  > Pregunta de trivia grupal, el primero en responder bien gana dinero y XP

 \`#math\`
  > Operación matemática grupal, el primero en responder bien gana dinero (cooldown 2 min por grupo)

 \`#wouldyourather\` / \`#wyr\`
  > Genera una pregunta de "¿Qué preferirías...?"

Usa #menu juegos para ver detalles kashira!

> (づ｡◕‿‿◕｡)づ *Acciones de Anime:* (${Object.keys(ANIME_ACTIONS).length} en total, gifs de OtakuGifs)
Úsalo solo (ej. \`#hug\`) para hacerlo contigo mismo, o menciona a alguien (\`#hug @usuario\`) para hacerlo con esa persona.

${buildAnimeMainMenuText()}

> (p^.^q) *Descargas:*
 \`#tt\`
  > Usando URL descarga tiktoks

 \`#fb\`
  > Usando URL descarga videos de Facebook

 \`#yta\`
  > Usando URL o Nombre descarga un audio de youtube

 \`#ytv\`
  > Lo mismo pero con video

 \`#pin\`
  > Busca arte seguro en Safebooru

 \`#lyrics [canción]\`
  > Busca la letra de una canción


> [>.<] *Administración:*
 \`#prom\`
  > Asciende a un miembro a administrador

 \`#dem\`
  > Desciende a un admin a miembro

 \`#desc\`
  > Cambiar descripción.

 \`#gname\`
  > Cambiar nombre del grupo.

 \`#gi\`
  > Muestra la info del grupo

 \`#k\`
  > Saca a alguien del grupo

 \`#del\`
  > Elimina un mensaje citado

 \`#gpfp\`
  > Modifica la foto del grupo

 \`#admins\`
  > Menciona solo a los administradores del grupo

 \`#tag [texto]\`
  > Menciona a todos de forma invisible; si citas/adjuntas una imagen, video o sticker, lo reenvía con esa mención

 \`#invitelink\`
  > Obtiene el link de invitación actual del grupo

 \`#revoke\`
  > Revoca y genera un nuevo link de invitación

 \`#setrules [texto]\` / \`#rules\`
  > Guarda o muestra las reglas del grupo

 \`#clearwarns [@usuario]\`
  > Elimina todas las advertencias de alguien de una sola vez

 \`#warn [@usuario] <motivo>\`
  > Da una advertencia con motivo; al llegar al límite (ver #warnlimit) expulsa, o si es admin solo le quita el admin

 \`#seew\` / \`#seewarns\`
  > Muestra las advertencias de un usuario (o las tuyas)

 \`#delwarn [@usuario] <número>\`
  > Elimina una advertencia específica

 \`#warnlimit [número|off]\`
  > Cambia cuántas advertencias hacen falta para el aviso de límite en este grupo (default 5)

 \`#on\` / \`#off <categoría>\`
  > Prende o apaga una categoría de comandos en este grupo

 \`#on chat\` / \`#off chat\`
  > Abre o cierra el grupo para que solo hablen admins

 \`#on antilink\` / \`#off antilink\`
  > Prende o apaga el borrado automático de links de invitación de otros grupos

 \`#on antiaudio\` / \`#off antiaudio\`
  > Prende o apaga el borrado automático de notas de voz y audios de no-admins

 \`#on antisticker\` / \`#off antisticker\`
  > Prende o apaga el borrado automático de stickers de no-admins

 \`#on antiimage\` / \`#off antiimage\`
  > Prende o apaga el borrado automático de imágenes de no-admins

 \`#on antivideo\` / \`#off antivideo\`
  > Prende o apaga el borrado automático de videos de no-admins

 \`#on antispam\` / \`#off antispam\`
  > Prende o apaga el borrado automático de mensajes repetidos muy seguidos

 \`#on antibot\` / \`#off antibot\`
  > Prende o apaga el borrado automático de mensajes con prefijos de otros bots

 \`#on onlyadmins\` / \`#off onlyadmins\`
  > Prende o apaga que solo los administradores puedan usar los comandos del bot en este grupo

 \`#toggles\`
  > Muestra el estado actual de todos los interruptores (#on/#off) de este grupo

 \`#lock [comando]\`
  > Bloquea o desbloquea un comando individual, solo para no-admins. Sin argumento muestra la lista.

 \`#nogm\`
  > Alterna si este grupo recibe los mensajes globales (#gm) del owner


> (T^T) *Bienvenidas:*
 \`#wel\`
  > Ve o configura el texto de bienvenida (usa #on wel / #off wel para prenderlo o apagarlo)

 \`#setwel\`
  > Modifica o establece una bienvenida

 \`#welimg\`
  > Modifica o establece una foto de bienvenida

 \`#twel\`
  > Prueba el welcome


> (._.)ﾉ *Despedidas:*
 \`#bye\`
  > Ve o configura el texto de despedida (usa #on bye / #off bye para prenderlo o apagarlo)

 \`#setbye\`
  > Modifica o establece una despedida

 \`#byeimg\`
  > Modifica o establece una foto de despedida

 \`#tbye\`
  > Prueba la despedida


> (๑˃ᴗ˂)ﻭ *Cumpleaños:*
 \`#birthday\`
  > Ve o configura el mensaje de cumpleaños (usa #on birthday / #off birthday para prenderlo o apagarlo)

 \`#setbirthday\`
  > Modifica o establece el mensaje de cumpleaños

 \`#birthdayimg\`
  > Modifica o establece una foto de cumpleaños

 \`#tbirthday\`
  > Prueba el mensaje de cumpleaños


> (•ิ_•ิ) *Owner Only:*
 \`#on bot\` \`#off bot\` \`#b\` \`#bi\` \`#pfp\`
 \`#globalon\` \`#globaloff\` \`#gm [mensaje]\`
 \`#delprofile\` \`#reset economy\`
 \`#promowner\` \`#demowner\` (solo owner original)
 \`#bugs\` \`#delbug <id>\` \`#delbugs\` \`#clrcache\` \`#restart\`

Sin explicación, si eres mi dueño al menos aprendete unos comandos kashira!\n

(^w^)
━━━━━━━━━━━━━━━━
¡Kashira!`,

  descargas: `*⌞ Categoría: Descargas ⌝*
━━━━━━━━━━━━━━━━
*Comando:* #tt
*Descripción:* Descarga videos de TikTok sin marca de agua kashira.
──
*Comando:* #fb
*Descripción:* Descarga videos de Facebook kashira.
──
*Comando:* #yta
*Descripción:* Descarga el audio de un video de YouTube.
──
*Comando:* #ytv
*Descripción:* Descarga videos de YouTube kashira.
──
*Comando:* #pin
*Descripción:* Busca y descarga imágenes seguras (SFW) desde Safebooru por etiquetas.
──
*Comando:* #lyrics [canción]
*Descripción:* Busca la letra de una canción. Si hay varias coincidencias, te deja elegir respondiendo con un número.
━━━━━━━━━━━━━━━━`,

  utilidades: `*⌞ Categoría: Utilidades ⌝*
━━━━━━━━━━━━━━━━
*Comando:* #invite <link>
*Descripción:* Hace que el bot solicite unirse a un grupo o comunidad a partir de su link de invitación (chat.whatsapp.com/...). Máximo *5 usos efectivos* por persona (uniones exitosas), para evitar abuso. Si es una comunidad, reporta a qué subgrupos quedó unido automáticamente (WhatsApp no permite unirse a todos los subgrupos de una sola vez, cada uno necesita su propio link o aceptación manual de un admin).
──
*Comando:* #s [descripción opcional]
*Descripción:* Convierte tus archivos multimedia en stickers (funciona con imágenes, videos/gifs y también con medios mandados como "ver una vez"). Si citas o adjuntas un sticker que ya existe, en vez de reconvertirlo solo le cambia el nombre/autor. El texto que pongas después de #s se usa como nombre del pack, junto con el nombre del grupo; el sticker también guarda tu nombre de perfil como autor, el crédito de Beatrice Bot y el link de Discord.
──
*Comando:* #p
*Descripción:* Muestra la latencia y velocidad interna del bot.
──
*Comando:* #toimg
*Descripción:* Transforma un sticker o una imagen normal a un JPG limpio kashira. También funciona con medios mandados como "ver una vez".
──
*Comando:* #calc [operación] [a] [b]
*Descripción:* Calculadora: sumar, restar, multiplicar, dividir, porcentaje, exponente, raiz.
──
*Comando:* #tr [idioma]
*Descripción:* Traduce el mensaje respondido al idioma indicado.
──
*Comando:* #qr [texto o link]
*Descripción:* Genera un código QR, o lo decodifica si respondes a una imagen.
──
*Comando:* #timer [minutos] [motivo (opcional)]
*Descripción:* Inicia un temporizador y avisa en el chat cuando termine. Máximo 1440 minutos (24h).
──
*Comando:* #poll [pregunta] | [opción 1] | [opción 2] | ...
*Descripción:* Crea una encuesta de WhatsApp. Separa la pregunta y cada opción con "|". Mínimo 2 opciones, máximo 12.
──
*Comando:* #define [palabra]
*Descripción:* Busca la definición de una palabra en el diccionario de la RAE.
──
*Comando:* #short [link]
*Descripción:* Acorta un link largo con TinyURL.
──
*Comando:* #encrypt [contraseña] [texto]
*Descripción:* Encripta un texto con una contraseña. Devuelve un código que solo se puede leer con #decrypt y la misma contraseña.
──
*Comando:* #decrypt [contraseña] [texto encriptado]
*Descripción:* Recupera el texto original de un mensaje encriptado, si la contraseña es correcta.
──
*Comando:* #bug [descripción]
*Descripción:* Reporta un error o bug del bot, queda guardado para que el owner lo revise.
──
*Comando:* #suggest [descripción]
*Descripción:* Manda una sugerencia o idea para el bot, queda guardada para que el owner la revise.
━━━━━━━━━━━━━━━━`,

  admin: `*⌞ Categoría: Administración ⌝*
━━━━━━━━━━━━━━━━
*Comando:* #tag [texto]
*Descripción:* Etiqueta de forma invisible a todos los miembros del grupo. Si citas o adjuntas una imagen, video o sticker, lo reenvía con esa misma mención invisible en vez de solo texto.
──
*Comando:* #prom
*Descripción:* Otorga el rango completo de administrador a un miembro.
──
*Comando:* #dem
*Descripción:* Remueve los permisos de administrador a un usuario.
──
*Comando:* #desc
*Descripción:* Cambia la descripcion del grupo
──
*Comando:* #gname
*Descripción:* Cambia el nombre del grupo
──
*Comando:* #gi
*Descripción:* Muestra los metadatos globales del grupo.
──
*Comando:* #k
*Descripción:* Elimina de forma permanente a un participante kashira.
──
*Comando:* #del
*Descripción:* Borra del chat el mensaje citado.
──
*Comando:* #gpfp
*Descripción:* Cambia la foto de perfil del grupo actual kashira (responde o adjunta una imagen). Lo pueden usar admins del grupo o el owner.
──
*Comando:* #warn @usuario <motivo>
*Descripción:* Da una advertencia con motivo. Al llegar al límite del grupo (5 por default, ver #warnlimit), avisa con el historial completo y actúa: si la persona NO es admin, la expulsa; si SÍ es admin, nunca la expulsa, solo le quita el admin (si Beatrice tiene rango para hacerlo) y avisa.
──
*Comando:* #seew / #seewarns @usuario
*Descripción:* Muestra las advertencias actuales de un usuario (o las tuyas si no mencionas a nadie).
──
*Comando:* #delwarn @usuario <número>
*Descripción:* Elimina una advertencia específica por su número en la lista.
──
*Comando:* #warnlimit [número|off]
*Descripción:* Cambia cuántas advertencias se necesitan para el aviso de "llegó al límite" en ESTE grupo (default 5, entre 1 y 50). #warnlimit off lo regresa al default.
──
*Comando:* #on / #off <categoría>
*Descripción:* Activa o desactiva una categoría completa de comandos en este grupo. Categorías: descargas, utilidades, welcome, perfil, juegos, economia.
──
*Comando:* #on chat / #off chat
*Descripción:* Abre el grupo para todos, o lo cierra para que solo hablen los admins.
──
*Comando:* #on antilink / #off antilink
*Descripción:* Borra automáticamente los links de invitación a otros grupos y da una advertencia (excepto a admins).
──
*Comando:* #on antiaudio / #off antiaudio
*Descripción:* Borra automáticamente las notas de voz y audios de no-admins, y da advertencia igual que #warn.
──
*Comando:* #on antisticker / #off antisticker
*Descripción:* Borra automáticamente los stickers de no-admins, y da advertencia igual que #warn.
──
*Comando:* #on antiimage / #off antiimage
*Descripción:* Borra automáticamente las imágenes de no-admins, y da advertencia igual que #warn.
──
*Comando:* #on antivideo / #off antivideo
*Descripción:* Borra automáticamente los videos de no-admins, y da advertencia igual que #warn.
──
*Comando:* #on antispam / #off antispam
*Descripción:* Borra automáticamente y advierte los mensajes muy repetidos y seguidos del mismo usuario.
──
*Comando:* #on antibot / #off antibot
*Descripción:* Borra automáticamente mensajes con prefijos típicos de otros bots (., !, /, etc.) para evitar choques entre bots, y da advertencia.
──
*Comando:* #on onlyadmins / #off onlyadmins
*Descripción:* Restringe (o vuelve a permitir) que solo los administradores usen los comandos del bot en este grupo. #menu, #bi, #on y #off siguen disponibles para todos.
──
*Comando:* #toggles
*Descripción:* Muestra de un vistazo el estado (ON/OFF) de todos los interruptores de este grupo: bot, chat, bienvenidas/despedidas/cumpleaños, antilink, los anti-X, onlyadmins, las categorías desactivadas y los comandos bloqueados con #lock.
──
*Comando:* #admins
*Descripción:* Menciona únicamente a todos los administradores del grupo.
──
*Comando:* #invitelink
*Descripción:* Obtiene el enlace de invitación actual del grupo.
──
*Comando:* #revoke
*Descripción:* Revoca el enlace de invitación actual y genera uno nuevo.
──
*Comando:* #setrules [texto]
*Descripción:* Guarda las reglas del grupo.
──
*Comando:* #rules
*Descripción:* Muestra las reglas guardadas del grupo.
──
*Comando:* #clearwarns @usuario
*Descripción:* Elimina todas las advertencias de un usuario de una sola vez.
──
*Comando:* #nogm
*Descripción:* Alterna (on/off) si este grupo recibe los mensajes globales (#gm) del owner principal. Solo admins.
──
*Comando:* #lock [comando]
*Descripción:* Bloquea o desbloquea un comando individual para que solo los admins puedan usarlo en este grupo. Sin argumento muestra la lista de comandos bloqueados.
━━━━━━━━━━━━━━━━`,

  welcome: `*⌞ Categoría: Bienvenidas y Despedidas ⌝*
━━━━━━━━━━━━━━━━
*Comando:* #wel
*Descripción:* Revisa el texto de bienvenida configurado. Actívalo o desactívalo con #on wel / #off wel.
──
*Comando:* #setwel
*Descripción:* Guarda el texto dinámico respetando todos tus saltos de línea (enters).
──
*Comando:* #welimg
*Descripción:* Asigna la imagen fija que se usará de fondo en las bienvenidas.
──
*Comando:* #twel
*Descripción:* Simula en tiempo real una entrada para ver cómo luce.
──
*Comando:* #bye
*Descripción:* Revisa el texto de despedida configurado. Actívalo o desactívalo con #on bye / #off bye.
──
*Comando:* #setbye
*Descripción:* Guarda el texto dinámico de despedida respetando todos tus saltos de línea (enters).
──
*Comando:* #byeimg
*Descripción:* Asigna la imagen fija que se usará de fondo en las despedidas.
──
*Comando:* #tbye
*Descripción:* Simula en tiempo real una salida para ver cómo luce.
──
*Comando:* #birthday
*Descripción:* Revisa el mensaje de cumpleaños configurado. Actívalo o desactívalo con #on birthday / #off birthday.
──
*Comando:* #setbirthday
*Descripción:* Guarda el texto dinámico de cumpleaños. Variables: {user}, {grupo}, {edad}.
──
*Comando:* #birthdayimg
*Descripción:* Asigna la imagen fija que se usará de fondo en las felicitaciones de cumpleaños.
──
*Comando:* #tbirthday
*Descripción:* Simula en tiempo real cómo luciría tu felicitación de cumpleaños.
──
_Nota: el bot revisa automáticamente cada día quién cumple años, usando la fecha guardada con #setbirth dd/mm/yyyy. Cada persona debe guardar su propia fecha._
━━━━━━━━━━━━━━━━`,

  owner: `*⌞ Categoría: Owner Only ⌝*
━━━━━━━━━━━━━━━━
*Comando:* #on bot / #off bot
*Descripción:* Enciende o apaga el bot dentro del chat actual.
──
*Comando:* #globalon / #globaloff
*Descripción:* Enciende o apaga el bot en TODOS los grupos donde esté kashira, de una sola vez.
──
*Comando:* #gm [mensaje]
*Descripción:* Envía un mensaje global (broadcast) a todos los grupos donde esté el bot, como aviso del owner principal. Los grupos con #nogm activo no lo reciben.
──
*Comando:* #b
*Descripción:* Añade o remueve a un usuario de la lista negra del bot.
──
*Comando:* #bi
*Descripción:* Muestra estadísticas internas de Node.js y uptime.
──
*Comando:* #pfp
*Descripción:* Actualiza la foto de perfil global de WhatsApp de este bot.
──
*Comando:* #delprofile @usuario
*Descripción:* Elimina por completo el perfil de un usuario kashira.
──
*Comando:* #reset economy group
*Descripción:* Resetea la economía (wallet, banco, títulos, objetos) de todos los miembros del grupo actual kashira.
──
*Comando:* #reset economy @usuario
*Descripción:* Resetea la economía de un usuario específico kashira.
──
*Comando:* #promowner @usuario
*Descripción:* Convierte a alguien en sub-owner: tendrá acceso a todos los comandos de owner excepto #promowner y #demowner. Exclusivo del owner original kashira.
──
*Comando:* #demowner @usuario
*Descripción:* Le quita el rango de sub-owner a alguien. Exclusivo del owner original kashira.
──
*Comando:* #bugs
*Descripción:* Muestra la lista de reportes de bugs y sugerencias que han mandado los usuarios con #bug y #suggest.
──
*Comando:* #delbug <id>
*Descripción:* Elimina un reporte o sugerencia por su ID (revisa los IDs con #bugs).
──
*Comando:* #delbugs
*Descripción:* Elimina TODOS los reportes y sugerencias guardados de una sola vez.
──
*Comando:* #clrcache
*Descripción:* Borra todos los gifs guardados en la caché de acciones de anime (se regeneran solos con el uso normal).
──
*Comando:* #restart
*Descripción:* Reinicia el bot de forma segura sin perder datos (la DB y la sesión ya están guardadas en disco). Requiere que el gestor de procesos (PM2, Railway, Docker, etc.) lo vuelva a levantar automáticamente.
━━━━━━━━━━━━━━━━`,

  perfil: `*⌞ Categoría: Perfil ⌝*
━━━━━━━━━━━━━━━━
*Comando:* #createprofile
*Descripción:* Crea tu perfil por primera vez kashira.
──
*Comando:* #profile / #profile @usuario
*Descripción:* Ver tu perfil o el de alguien más kashira, incluye el título y los objetos que tengas equipados.
──
*Comando:* #setname [nombre]
*Descripción:* Cambia tu nombre en el perfil kashira.
──
*Comando:* #setgender [género]
*Descripción:* Establece tu género kashira.
──
*Comando:* #profiledesc [texto]
*Descripción:* Escribe una descripción para tu perfil kashira.
──
*Comando:* #favorite [categoría] [texto]
*Descripción:* Guarda un favorito para tu perfil (ej: personaje, anime, juego). Sin argumentos muestra todos tus favoritos guardados. Se muestran en #profile kashira.
──
*Comando:* #profilepfp
*Descripción:* Cambia la foto de tu perfil adjuntando una imagen kashira.
──
*Comando:* #setbirth [dd/mm/yyyy]
*Descripción:* Guarda tu fecha de nacimiento kashira.
──
*Comando:* #setprofile pub/priv
*Descripción:* Pon tu perfil público o privado kashira.
──
*Comando:* #stats / #stats @usuario
*Descripción:* Muestra las estadísticas completas (comandos, mensajes, saldo, advertencias, títulos y objetos) tuyas o de alguien más kashira.
──
*Comando:* #marry @usuario
*Descripción:* Propone matrimonio a alguien kashira.
──
*Comando:* #marry accept @usuario
*Descripción:* Acepta una propuesta de matrimonio kashira.
──
*Comando:* #divorce
*Descripción:* Termina el matrimonio actual kashira.
──
*Comando:* #level / #level @usuario
*Descripción:* Muestra tu nivel y XP actual (o el de alguien más), y cuánta XP falta para subir. Se gana XP mandando mensajes y usando comandos kashira.
──
*Comando:* #adoptpet lista [tipo]
*Descripción:* Ve las 50 mascotas disponibles (Pokémon), agrupadas por tipo (fuego/tierra/aire/planta/agua) con su rareza y precio.
──
*Comando:* #adoptpet [especie] [nombre]
*Descripción:* Adopta una mascota kashira (máximo 1 a la vez, paga desde el banco de este grupo). Ej: #adoptpet charmander Luna.
──
*Comando:* #pet / #pet @usuario
*Descripción:* Muestra la tarjeta completa de tu mascota (o la de alguien más): especie, nivel, XP, rareza, tipo, hambre/felicidad y bonificación activa.
──
*Comando:* #releasepet
*Descripción:* Da tu mascota en adopción kashira (sin reembolso) para poder adoptar otra.
──
*Comando:* #renamepet [nombre nuevo]
*Descripción:* Corrige el nombre de tu mascota kashira (por si te equivocaste al escribirlo en #adoptpet).
──
*Comando:* #feedpet
*Descripción:* Alimenta a tu mascota kashira, sube su hambre a 100% y da algo de XP. Cooldown 12h. Si el hambre baja a 50% o menos, se desactiva la bonificación hasta volver a alimentarla.
──
*Comando:* #playpet
*Descripción:* Juega con tu mascota kashira, sube su felicidad a 100% y da algo de XP. Cooldown 8h. Si la felicidad baja a 50% o menos, se desactiva la bonificación hasta volver a jugar con ella.
──
*Comando:* #preg [nombre] (alias #pregnant)
*Descripción:* Tú y tu pareja tienen un hijo kashira. Requiere estar casados, cooldown 1 día compartido entre ambos, y máximo 3 hijos por pareja. El hijo nace en etapa Bebé y crece con el tiempo real (se ve en #profile).
──
*Comando:* #renamekid [número] [nombre nuevo]
*Descripción:* Corrige el nombre de un hijo kashira (por si te equivocaste al escribirlo en #preg). Usa el número según el orden en que aparece en #profile, no el nombre — así funciona aunque el nombre actual esté mal escrito.
──
*Comando:* #pvsp @contrincante [apuesta]
*Descripción:* Reta la mascota de alguien más a una pelea kashira. Solo puedes retar dentro de ±5 niveles de diferencia. Quien es retado ve el nombre/nivel de ambas mascotas y decide si acepta con #acceptvs.
──
*Comando:* #acceptvs @contrincante
*Descripción:* Acepta el reto pendiente de esa persona. El ganador se decide por el tipo elemental de cada mascota (con ventaja/desventaja según el ciclo Fuego/Tierra/Aire/Planta/Agua) ajustado por nivel, nunca 100% seguro ni 100% perdido. Se transfiere la apuesta entre ambos jugadores (no se crea dinero nuevo) y ambas mascotas ganan algo de XP. Cooldown de 30s para ambos al terminar.
──
*Comando:* #nick @usuario [apodo] (o #nick [apodo] @usuario)
*Descripción:* Ponle un apodo a alguien kashira, mencionándolo o citando su mensaje. Solo letras normales (sin números, tildes, ñ ni símbolos), 2-20 caracteres. Es LOCAL: solo tú puedes usarlo, para referirte a esa persona en vez de mencionarla en varios comandos (#pay, #steal, #pvsp, #acceptvs, #marry, #pet, #level, #profile, #stats, #bal, #inv, #rat, #simp, #iq, #gay, #lesbian, #bisexual, #freaky, #otaku, #funny). Ambos deben tener perfil creado. Usa #nick @usuario off para quitarlo.
──
*Comando:* #nicks
*Descripción:* Muestra dos listas kashira: los apodos que OTROS te han puesto a ti ("impuestos") y los que TÚ le has puesto a otros ("puestos"), con el nombre de perfil de cada quien.
──
*Comando:* #afk [motivo]
*Descripción:* Te marca como AFK kashira, con un motivo opcional. Mientras estés AFK, si alguien te menciona o responde tu mensaje (en cualquier grupo), el bot avisa que estás ausente y desde cuándo. Se te quita automáticamente en cuanto vuelvas a escribir algo (o usa #afk off para quitártelo tú mismo/a).
──
*Comando:* #couples
*Descripción:* Lista las parejas casadas (con #marry) que siguen activas y siguen siendo miembros de ESTE grupo, ordenadas por antigüedad.
━━━━━━━━━━━━━━━━`,

  juegos: `*⌞ Categoría: Juegos ⌝*
━━━━━━━━━━━━━━━━
*Comando:* #ship @usuario1 @usuario2
*Descripción:* Calcula la compatibilidad entre dos personas kashira. Si solo mencionas a una, se hace contigo.
──
*Comando:* #vs @usuario1 @usuario2
*Descripción:* Decide quién ganaría en una pelea entre dos personas kashira. Si solo mencionas a una, se hace contigo.
──
*Comando:* #best @usuario1 @usuario2
*Descripción:* Determina quién es mejor persona de las dos kashira. Si solo mencionas a una, se hace contigo.
──
*Comando:* #rat @usuario
*Descripción:* Mide qué tan rata es alguien kashira.
──
*Comando:* #simp @usuario
*Descripción:* Mide qué tan simp es alguien kashira.
──
*Comando:* #iq @usuario
*Descripción:* Mide el IQ (falso) de alguien kashira.
──
*Comando:* #gay @usuario
*Descripción:* Mide qué tan gay es alguien kashira.
──
*Comando:* #lesbian @usuario
*Descripción:* Mide qué tan lesbiana es alguien kashira.
──
*Comando:* #bisexual @usuario
*Descripción:* Mide qué tan bi es alguien kashira.
──
*Comando:* #freaky @usuario
*Descripción:* Mide qué tan freaky es alguien kashira.
──
*Comando:* #otaku @usuario
*Descripción:* Mide qué tan otaku es alguien kashira.
──
*Comando:* #funny @usuario
*Descripción:* Mide qué tan gracioso es alguien kashira.
──
*Comando:* #8ball [pregunta]
*Descripción:* Le preguntas algo a la bola 8 y te da una respuesta al azar kashira.
──
*Comando:* #wouldyourather / #wyr
*Descripción:* Genera una pregunta de "¿Preferirías...?" con dos opciones para debatir.
──
*Comando:* #math
*Descripción:* Genera una operación matemática al azar en el grupo. El primero en responder bien gana dinero. 30 segundos, cooldown de 2 min por grupo entre retos.
──
*Comando:* #trivia [categoría opcional]
*Descripción:* Lanza una pregunta de trivia al grupo (anime, videojuegos, historia, ciencia, geografia). El primero en responder bien gana dinero y XP. Se acepta un pequeño margen de error ortográfico en la respuesta. 30 segundos, cooldown de 2 min por grupo entre retos.
━━━━━━━━━━━━━━━━`,

  animeactions: buildAnimeMenuText(),

  economia: `*⌞ Categoría: Economía ⌝*
━━━━━━━━━━━━━━━━
*Comando:* #w / #work
*Descripción:* Trabaja y gana entre 3,300¥ y 4,000¥. Cooldown 1 min.
──
*Comando:* #crime
*Descripción:* Comete un crimen: 5,500¥-7,500¥ si sale bien, riesgo de perder 7,500¥-9,200¥. Cooldown 5 min.
──
*Comando:* #dungeon / #mazmorra
*Descripción:* Explora una mazmorra: 10,000¥-13,000¥ si sales bien. 20% de morir y perder el 15% de tu bolsillo (wallet). Cooldown 2:30 min.
──
*Comando:* #ritual
*Descripción:* Haz un ritual: 20,000¥-30,000¥ si sale bien. 20% de ser absorbido por el portal y perder el 8% de tu dinero total (bolsillo + banco). Cooldown 4 min.
──
*Comando:* #adventure / #aventura
*Descripción:* Sal de aventura: 18,000¥-21,000¥ si sale bien. 25% de un evento random que no te da nada esta vez y le suma 5 minutos a TODOS tus cooldowns activos (2:30 si tienes la ventaja Cooldown). Cooldown 2:30 min.
──
*Comando:* #slut
*Descripción:* Gana rápido: 9,000¥-15,000¥ si sale bien. 40% de perder 12,000¥-20,000¥. Cooldown 2:30 min.
──
*Comando:* #daily
*Descripción:* Reclama tu recompensa diaria: 30,000¥ base + 5,000¥ por cada día consecutivo de racha. Cooldown 24h, la racha se rompe si dejas pasar más de 48h sin reclamar.
──
*Comando:* #steal @usuario
*Descripción:* Roba a alguien inactivo 30+ min con 20,000¥+ fuera del banco. 80% de éxito. Cooldown 30 min.
──
*Comando:* #mine [zona 1-5]
*Descripción:* Mina en una de 5 cuevas temáticas de anime, requiere pico equipado (#buy pico). Da varios materiales + dinero. Cooldown 4 min. 12% de encontrar cofre (si no tienes llave, tienes 1 min para conseguirla antes de que se pierda), 5% de morir y perder materiales, dinero y tu pico actual.
──
*Comando:* #fish [zona 1-5]
*Descripción:* Pesca en uno de 5 lagos temáticos de anime, requiere caña equipada (#buy caña). Igual que #mine pero sin riesgo de muerte; sus llaves se craftean con #craft en vez de comprarse.
──
*Comando:* #sell / #vender [material] [cantidad|all]
*Descripción:* Vende materiales obtenidos con #mine o #fish a cambio de dinero en tu bolsillo.
──
*Comando:* #craft llave [zona 1-5]
*Descripción:* Craftea una llave de lago usando materiales de minería, para abrir cofres en #fish.
──
*Comando:* #tools
*Descripción:* Muestra todos los picos y cañas disponibles: precio/materiales para craftear, usos y probabilidad de fallo.
──
*Comando:* #zones
*Descripción:* Muestra las 5 zonas de #mine y las 5 de #fish, con sus materiales, probabilidades y cómo conseguir sus llaves.
──
*Comando:* #mats
*Descripción:* Muestra todos los materiales de minería y pesca con su precio de venta.
──
*Comando:* #keys
*Descripción:* Muestra el precio de todas las llaves de mina y la receta de todas las llaves de lago.
──
*Comando:* #d / #deposit [monto|all]
*Descripción:* Guarda dinero en el banco, a salvo de robos kashira.
──
*Comando:* #with / #retirar [monto|all]
*Descripción:* Saca dinero del banco para poder usarlo kashira.
──
*Comando:* #bal / #bal @usuario
*Descripción:* Consulta tu saldo o el de alguien más kashira.
──
*Comando:* #cf [monto]
*Descripción:* Coinflip, doblas o pierdes tu apuesta. Mínimo 2,000¥, cooldown 30s.
──
*Comando:* #rt [monto] [rojo|negro]
*Descripción:* Ruleta, elige color y dobla o pierde. Mínimo 2,000¥, cooldown 30s.
──
*Comando:* #slots [monto]
*Descripción:* Tragamonedas: salen 3 símbolos al azar. Dos iguales pagan x1, tres iguales pagan x3, y tres "7" son jackpot (x15, muy raro). Mínimo 2,000¥, cooldown 30s.
──
*Comando:* #dice [monto]
*Descripción:* Tú y Beatrice lanzan un dado del 1 al 6, el mayor gana la apuesta; en empate se devuelve. Mínimo 2,000¥, cooldown 30s.
──
*Comando:* #pay [monto] @usuario
*Descripción:* Transfiere dinero desde tu banco. Mínimo 3,000¥. También acepta un apodo que le hayas puesto con #nick en vez de mencionarlo.
──
*Comando:* #top mensajes
*Descripción:* Top 5 de quienes más mensajes y comandos han mandado en este grupo kashira.
──
*Comando:* #top mensajes global
*Descripción:* Top 10 de mensajes/comandos de todo el bot. Cada perfil aparece una sola vez (su grupo con más mensajes), mostrando en cuál es kashira.
──
*Comando:* #top coins
*Descripción:* Top 5 de fortuna (bolsillo+banco) de este grupo kashira.
──
*Comando:* #top coins global
*Descripción:* Top 10 de fortuna de todo el bot. Cada perfil aparece una sola vez (su grupo con más fortuna), mostrando en cuál es kashira.
──
*Comando:* #top level
*Descripción:* Top 10 de niveles/XP de todo el bot kashira. Siempre es global, el nivel no es algo que exista solo en un grupo.
──
*Comando:* #shop
*Descripción:* Muestra la tienda de títulos, ventajas y objetos kashira. Usa #shop buscar [texto] para buscar en todo a la vez sin tener que saber en qué categoría/anime está. Las listas marcan lo que ya tienes y lo que no te alcanza.
──
*Comando:* #buy / #comprar [nombre]
*Descripción:* Compra algo de la tienda con dinero del banco kashira. También sirve para picos/cañas: #buy pico [cant], #buy pico pro [cant], #buy pico dios [cant] (igual con caña), y llaves de mina: #buy llave [zona]. Nivel Pro y Dios se craftean con dinero + materiales y pueden fallar 5% por unidad (se compran de una en una, no todas juntas).
──
*Comando:* #customtitle [texto]
*Descripción:* Compra o cambia tu título personalizado. Cuesta 120,000¥ + 12,000¥ por carácter (ej: "Mooz" = 168,000¥). No puede repetir un título ya existente kashira.
──
*Comando:* #equip / #unequip [nombre]
*Descripción:* Equipa o desequipa un título/objeto comprado kashira. También funciona con títulos de rango global y tu título personalizado. Para herramientas: #equip pico / #equip pico pro / #equip pico dios (igual con caña) elige manualmente cuál usar de las que tengas; al comprar/craftear se auto-equipa la mejor.
──
*Comando:* #inv / #inventario
*Descripción:* Muestra lo que tienes equipado y en inventario kashira.
──
*Comando:* #perks
*Descripción:* Muestra tus ventajas activas kashira.
──
*Títulos de rango global:* El top 1, 2 y 3 en coins de todo el bot reciben automáticamente un título exclusivo en su inventario ("El rey de las coins #1", "Príncipe monetario (#2)", "El tercero"), que se retira solo si pierden el puesto kashira.
──
*Zonas de #mine:* 1) Cueva de Piedra 2) Mina Abandonada 3) Fortaleza del Nether (Pico Pro+) 4) El Fin (Pico Pro+) 5) Guarida del Warden (Pico Dios).
*Zonas de #fish:* 1) Estanque de Aldea 2) Río del Bosque 3) Monumento Oceánico (Caña Pro+) 4) Ruinas Sumergidas (Caña Pro+) 5) Lago Sulfúrico (Caña Dios).
━━━━━━━━━━━━━━━━`,

  editor: `*⌞ Categoría: Editor Multimedia ⌝*
━━━━━━━━━━━━━━━━
_Todos estos comandos se usan respondiendo (citando) al audio, video, sticker o imagen que quieras editar._

*Comando:* #tomp3 / #toaudio
*Descripción:* Extrae el audio de un video o nota de voz citada y lo devuelve en mp3.
──
*Comando:* #comp
*Descripción:* Reduce el peso de un video o imagen citado.
──
*Comando:* #blur
*Descripción:* Desenfoca la imagen o sticker citado.
──
*Comando:* #sharpen
*Descripción:* Aumenta la nitidez de la imagen o sticker citado.
──
*Comando:* #invert
*Descripción:* Invierte los colores de la imagen o sticker citado.
──
*Comando:* #reverse
*Descripción:* Invierte un video citado para que se reproduzca al revés.
━━━━━━━━━━━━━━━━`,
};

// ─── MANEJADOR DE COMANDOS ────────────────────────────────────────────────────
// Busca el número de perfil correcto dado un JID (PN o LID)
function findProfileNum(db, jid) {
  if (!jid) return null;
  const num = jid.split("@")[0].split(":")[0];
  // Buscar directo
  if (db.profiles?.[num]) return num;
  // Buscar en el mapa LID→PN
  const resolved = resolveToPN(jid);
  const resolvedNum = resolved.split("@")[0].split(":")[0];
  if (db.profiles?.[resolvedNum]) return resolvedNum;
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//    APODOS (#nick): LOCALES a quien los pone — cada usuario tiene los suyos,
//    y solo esa persona puede usarlos para referirse a otros en comandos como
//    #pay (en vez de tener que mencionarlos siempre). Solo letras normales
//    (sin números/tildes/ñ/símbolos), para que no choquen con montos u otros
//    argumentos al parsear esos comandos.
// db.nicknames[senderNum][targetNum] = "Apodo"
// ═══════════════════════════════════════════════════════════════════════════
const NICK_RESERVED_WORDS = ["all", "global", "off", "normal", "reset"];

function normalizeNick(nick) {
  return normalizeText(nick);
}

function setNickname(db, senderNum, targetNum, nick) {
  db.nicknames = db.nicknames || {};
  db.nicknames[senderNum] = db.nicknames[senderNum] || {};
  db.nicknames[senderNum][targetNum] = nick;
}

function removeNickname(db, senderNum, targetNum) {
  if (db.nicknames?.[senderNum]) delete db.nicknames[senderNum][targetNum];
}

// ¿SENDERNUM ya tiene ESE apodo (insensible a mayúsculas) puesto en OTRO usuario?
// Devuelve el targetNum que ya lo tiene, o null si está libre.
function findNickOwnerTarget(db, senderNum, nick) {
  const map = db.nicknames?.[senderNum];
  if (!map) return null;
  const norm = normalizeNick(nick);
  for (const [tNum, n] of Object.entries(map)) {
    if (normalizeNick(n) === norm) return tNum;
  }
  return null;
}

// Busca, palabra por palabra dentro de un texto libre (ej. el "rest" de #pay), algún
// apodo que SENDERNUM tenga guardado, y devuelve el targetNum correspondiente (o null).
function resolveNicknameInText(db, senderNum, text) {
  const map = db.nicknames?.[senderNum];
  if (!map) return null;
  const words = normalizeText(text).split(/\s+/).filter(Boolean);
  for (const [tNum, nick] of Object.entries(map)) {
    if (words.includes(normalizeNick(nick))) return tNum;
  }
  return null;
}

// Resuelve a quién apunta un comando: primero por mención/reply; si no hay ninguna,
// busca si alguna palabra del texto coincide con un apodo (#nick) que SENDERNUM le
// haya puesto a alguien. Devuelve un jid (igual que getMentionedJid) o null.
function resolveMentionOrNick(db, msg, senderNum, text) {
  const mention = resolveToPN(getMentionedJid(msg));
  if (mention) return mention;
  const nickNum = resolveNicknameInText(db, senderNum, text || "");
  return nickNum ? nickNum + "@s.whatsapp.net" : null;
}

// ═══════════════════════════════════════════════════════════════════════════
//    SISTEMA DE ECONOMÍA
// ═══════════════════════════════════════════════════════════════════════════

const ECO = {
  WORK_MIN: 3300, WORK_MAX: 4000, WORK_CD: 60 * 1000,
  CRIME_MIN: 5500, CRIME_MAX: 7500, CRIME_FAIL_MIN: 7500, CRIME_FAIL_MAX: 9200,
  CRIME_FAIL_CHANCE: 0.40, CRIME_CD: 5 * 60 * 1000,
  STEAL_SUCCESS_CHANCE: 0.80, STEAL_MIN_PCT: 0.35, STEAL_MAX_PCT: 0.50,
  STEAL_MIN_TARGET_WALLET: 20000, STEAL_TARGET_INACTIVE: 30 * 60 * 1000, STEAL_CD: 30 * 60 * 1000,
  BET_MIN: 2000, PAY_MIN: 3000,
  // Tope de cuánto puedes apostar (sumado entre #cf, #rt, #slots y #dice) en una ventana de 1 hora.
  BET_HOURLY_CAP: 100000000, BET_HOURLY_WINDOW_MS: 60 * 60 * 1000,
  DAILY_BASE: 30000, DAILY_STREAK_BONUS: 5000, DAILY_CD: 24 * 60 * 60 * 1000, DAILY_STREAK_RESET: 48 * 60 * 60 * 1000,
  // Cooldown unificado para todos los juegos de apuestas (#cf, #rt, #slots, #dice): bajado de 1 min a 30s.
  CF_CD: 30 * 1000, RT_CD: 30 * 1000,
  SLOTS_CD: 30 * 1000, SLOTS_DOUBLE_MULT: 1, SLOTS_TRIPLE_MULT: 3, SLOTS_JACKPOT_MULT: 15,
  DICE_CD: 30 * 1000,
  // Variantes de #w: mismo esqueleto (recompensa, cooldown, % de fallar) con temas distintos.
  DUNGEON_MIN: 10000, DUNGEON_MAX: 13000, DUNGEON_CD: 150 * 1000, DUNGEON_DEATH_CHANCE: 0.20, DUNGEON_DEATH_LOSS_PCT: 0.15,
  RITUAL_MIN: 20000, RITUAL_MAX: 30000, RITUAL_CD: 4 * 60 * 1000, RITUAL_ABSORB_CHANCE: 0.20, RITUAL_ABSORB_LOSS_PCT: 0.08,
  // Adventure: recompensa subida (antes 13000-15000) para compensar que su "evento malo"
  // castiga TODOS los cooldowns activos a la vez, no solo el suyo como dungeon/ritual.
  ADVENTURE_MIN: 18000, ADVENTURE_MAX: 21000, ADVENTURE_CD: 150 * 1000, ADVENTURE_EVENT_CHANCE: 0.25, ADVENTURE_DELAY_MS: 5 * 60 * 1000,
  SLUT_MIN: 9000, SLUT_MAX: 15000, SLUT_CD: 150 * 1000, SLUT_FAIL_CHANCE: 0.40, SLUT_FAIL_MIN: 12000, SLUT_FAIL_MAX: 20000,
  // Tope máximo de banco por defecto (por grupo). Se puede subir comprando mejoras en #shop banco.
  BANK_CAP: 10000000,
};

// Todos los timestamps de cooldown de la economía. Se usa para #adventure, cuyo
// evento de retraso le suma minutos a TODOS los cooldowns activos de la persona.
const ECO_COOLDOWN_FIELDS = [
  "lastWork", "lastCrime", "lastSteal", "lastDaily", "lastCf", "lastRt", "lastSlots", "lastDice",
  "lastDungeon", "lastRitual", "lastAdventure", "lastSlut",
];

// ══════════════════════════════
//    MASCOTAS E HIJOS
// ══════════════════════════════

// Los 5 tipos elementales de mascota, en el orden del ciclo (cada uno le gana leve
// al siguiente y fuerte al que sigue después de ese; pierde igual contra los 2 anteriores).
const PET_TYPES = ["fuego", "tierra", "aire", "planta", "agua"];
const PET_TYPE_EMOJI = { fuego: "🔥", tierra: "🪨", aire: "💨", planta: "🌿", agua: "💧" };
const PET_TYPE_LABEL = { fuego: "Fuego", tierra: "Tierra", aire: "Aire", planta: "Planta", agua: "Agua" };

// Devuelve la relación de "myType" contra "otherType": "mega_counter", "counter",
// "neutral", "anti_counter" o "mega_anti_counter". Se calcula a partir de la posición
// en el ciclo PET_TYPES, así queda automáticamente simétrico (si A mega-cuentrea a B,
// B mega-sufre contra A) sin tener que escribir una tabla a mano para las 25 combinaciones.
function petTypeRelation(myType, otherType) {
  const i = PET_TYPES.indexOf(myType);
  const j = PET_TYPES.indexOf(otherType);
  if (i === -1 || j === -1) return "neutral";
  const diff = (j - i + PET_TYPES.length) % PET_TYPES.length;
  // diff=0 → mismo tipo (neutral). diff=1 → el siguiente en el ciclo le gana leve a myType
  // (osea myType es "counter" en su contra). diff=2 → le gana fuerte (mega_counter).
  // diff=3 → myType le gana leve (anti_counter). diff=4 → myType le gana fuerte (mega_anti_counter).
  if (diff === 0) return "neutral";
  if (diff === 1) return "counter";           // otherType te cuentrea leve
  if (diff === 2) return "mega_counter";      // otherType te cuentrea fuerte
  if (diff === 3) return "anti_counter";      // tú cuentreas leve a otherType
  return "mega_anti_counter";                 // tú cuentreas fuerte a otherType
}

// Probabilidad base de VICTORIA para quien tiene myType, antes de ajustar por nivel.
const PET_TYPE_WIN_CHANCE = {
  mega_counter: 0.20,
  counter: 0.35,
  neutral: 0.50,
  anti_counter: 0.65,
  mega_anti_counter: 0.80,
};

// Bono de rareza a nivel 50 (tope). Sube en línea recta desde nivel 1 hasta 50 y ahí
// se congela: el nivel sigue subiendo después de 50 pero ya no mejora la bonificación.
const PET_RARITY_BONUS = {
  comun: { xpPct: 8, cdPct: 12 },
  raro: { xpPct: 12, cdPct: 18 },
  epico: { xpPct: 16, cdPct: 24 },
  legendario: { xpPct: 20, cdPct: 30 },
};
const PET_BONUS_LEVEL_CAP = 50;
// Debajo de este % en hambre o felicidad, la bonificación completa se desactiva
// (aunque el nivel/xp de la mascota se sigan guardando normal).
const PET_STAT_MIN_FOR_BONUS = 50;

const PET_ADOPT_PRICE = {
  comun: [150000, 300000],
  raro: [400000, 700000],
  epico: [900000, 1500000],
  legendario: [2000000, 3000000],
};

// Catálogo de 50 mascotas: 10 Pokémon por cada uno de los 5 tipos, ordenados de más
// débil/barata (Común) a más fuerte/cara (Legendario) dentro de cada tipo.
// Reparto de rareza por tipo (10 mascotas): 4 Común, 3 Raro, 2 Épico, 1 Legendario.
const POKEMON_CATALOG = [
  // 🔥 Fuego
  { id: "charmander", name: "Charmander", type: "fuego", rarity: "comun" },
  { id: "charmeleon", name: "Charmeleon", type: "fuego", rarity: "comun" },
  { id: "vulpix", name: "Vulpix", type: "fuego", rarity: "comun" },
  { id: "growlithe", name: "Growlithe", type: "fuego", rarity: "comun" },
  { id: "ninetales", name: "Ninetales", type: "fuego", rarity: "raro" },
  { id: "cyndaquil", name: "Cyndaquil", type: "fuego", rarity: "raro" },
  { id: "torchic", name: "Torchic", type: "fuego", rarity: "raro" },
  { id: "charizard", name: "Charizard", type: "fuego", rarity: "epico" },
  { id: "arcanine", name: "Arcanine", type: "fuego", rarity: "epico" },
  { id: "infernape", name: "Infernape", type: "fuego", rarity: "legendario" },
  // 🪨 Tierra
  { id: "sandshrew", name: "Sandshrew", type: "tierra", rarity: "comun" },
  { id: "sandslash", name: "Sandslash", type: "tierra", rarity: "comun" },
  { id: "diglett", name: "Diglett", type: "tierra", rarity: "comun" },
  { id: "dugtrio", name: "Dugtrio", type: "tierra", rarity: "comun" },
  { id: "onix", name: "Onix", type: "tierra", rarity: "raro" },
  { id: "marowak", name: "Marowak", type: "tierra", rarity: "raro" },
  { id: "rhyhorn", name: "Rhyhorn", type: "tierra", rarity: "raro" },
  { id: "rhydon", name: "Rhydon", type: "tierra", rarity: "epico" },
  { id: "gliscor", name: "Gliscor", type: "tierra", rarity: "epico" },
  { id: "groudon", name: "Groudon", type: "tierra", rarity: "legendario" },
  // 💨 Aire
  { id: "pidgey", name: "Pidgey", type: "aire", rarity: "comun" },
  { id: "pidgeotto", name: "Pidgeotto", type: "aire", rarity: "comun" },
  { id: "spearow", name: "Spearow", type: "aire", rarity: "comun" },
  { id: "fearow", name: "Fearow", type: "aire", rarity: "comun" },
  { id: "zubat", name: "Zubat", type: "aire", rarity: "raro" },
  { id: "golbat", name: "Golbat", type: "aire", rarity: "raro" },
  { id: "pidgeot", name: "Pidgeot", type: "aire", rarity: "raro" },
  { id: "crobat", name: "Crobat", type: "aire", rarity: "epico" },
  { id: "aerodactyl", name: "Aerodactyl", type: "aire", rarity: "epico" },
  { id: "rayquaza", name: "Rayquaza", type: "aire", rarity: "legendario" },
  // 🌿 Planta
  { id: "bulbasaur", name: "Bulbasaur", type: "planta", rarity: "comun" },
  { id: "ivysaur", name: "Ivysaur", type: "planta", rarity: "comun" },
  { id: "oddish", name: "Oddish", type: "planta", rarity: "comun" },
  { id: "gloom", name: "Gloom", type: "planta", rarity: "comun" },
  { id: "vileplume", name: "Vileplume", type: "planta", rarity: "raro" },
  { id: "bellsprout", name: "Bellsprout", type: "planta", rarity: "raro" },
  { id: "weepinbell", name: "Weepinbell", type: "planta", rarity: "raro" },
  { id: "victreebel", name: "Victreebel", type: "planta", rarity: "epico" },
  { id: "venusaur", name: "Venusaur", type: "planta", rarity: "epico" },
  { id: "sceptile", name: "Sceptile", type: "planta", rarity: "legendario" },
  // 💧 Agua
  { id: "squirtle", name: "Squirtle", type: "agua", rarity: "comun" },
  { id: "wartortle", name: "Wartortle", type: "agua", rarity: "comun" },
  { id: "psyduck", name: "Psyduck", type: "agua", rarity: "comun" },
  { id: "golduck", name: "Golduck", type: "agua", rarity: "comun" },
  { id: "poliwag", name: "Poliwag", type: "agua", rarity: "raro" },
  { id: "poliwhirl", name: "Poliwhirl", type: "agua", rarity: "raro" },
  { id: "magikarp", name: "Magikarp", type: "agua", rarity: "raro" },
  { id: "poliwrath", name: "Poliwrath", type: "agua", rarity: "epico" },
  { id: "blastoise", name: "Blastoise", type: "agua", rarity: "epico" },
  { id: "gyarados", name: "Gyarados", type: "agua", rarity: "legendario" },
];

function findPokemon(id) {
  return POKEMON_CATALOG.find(p => p.id === id) || null;
}

// XP necesaria para subir del nivel N al N+1 (mismo estilo que xpForLevel de perfil,
// pero independiente: la mascota tiene su propia progresión).
function petXpForLevel(level) {
  return 100 + level * 60;
}

// Hambre/Felicidad NO se guardan como número fijo: se calculan al vuelo a partir de
// cuánto ha pasado desde el último #feedpet/#playpet (mismo estilo "perezoso" que ya
// usan los cooldowns de todo el bot, sin necesitar un cron/scheduler en segundo plano).
const PET_HUNGER_DECAY_HOURS_TO_ZERO = 72;   // 3 días sin alimentar → 0% hambre
const PET_HAPPINESS_DECAY_HOURS_TO_ZERO = 48; // 2 días sin jugar → 0% felicidad

function getPetLiveStats(pet) {
  if (!pet) return { hunger: 0, happiness: 0 };
  const now = Date.now();
  const hoursSinceFed = (now - (pet.lastFed || now)) / (60 * 60 * 1000);
  const hoursSincePlayed = (now - (pet.lastPlayed || now)) / (60 * 60 * 1000);
  const hunger = Math.max(0, Math.min(100, Math.round(100 - (hoursSinceFed / PET_HUNGER_DECAY_HOURS_TO_ZERO) * 100)));
  const happiness = Math.max(0, Math.min(100, Math.round(100 - (hoursSincePlayed / PET_HAPPINESS_DECAY_HOURS_TO_ZERO) * 100)));
  return { hunger, happiness };
}

// Bonificación efectiva de una mascota AHORA MISMO: {xpPct, cdPct, active}.
// active=false si hambre o felicidad están en 50% o menos (aunque el nivel siga guardado).
function getPetBonus(pet) {
  if (!pet) return { xpPct: 0, cdPct: 0, active: false };
  const { hunger, happiness } = getPetLiveStats(pet);
  const rarity = PET_RARITY_BONUS[pet.rarity] || PET_RARITY_BONUS.comun;
  const progress = Math.min(pet.level || 1, PET_BONUS_LEVEL_CAP) / PET_BONUS_LEVEL_CAP;
  const active = hunger > PET_STAT_MIN_FOR_BONUS && happiness > PET_STAT_MIN_FOR_BONUS;
  return {
    xpPct: Math.round(progress * rarity.xpPct * 10) / 10,
    cdPct: Math.round(progress * rarity.cdPct * 10) / 10,
    active,
  };
}

function petPrice(rarity) {
  const range = PET_ADOPT_PRICE[rarity] || PET_ADOPT_PRICE.comun;
  return range[0];
}

const PET_FEED_CD = 12 * 60 * 60 * 1000; // 12h (el hambre llega a 0% en 72h sin alimentar)
const PET_PLAY_CD = 8 * 60 * 60 * 1000;  // 8h (la felicidad llega a 0% en 48h sin jugar)
const PET_FEED_XP = [10, 20];
const PET_PLAY_XP = [10, 20];
const PET_RARITY_LABEL = { comun: "Común", raro: "Raro", epico: "Épico", legendario: "Legendario" };

// Suma XP a una mascota y sube de nivel las veces que haga falta (sin tope de nivel).
// Devuelve cuántos niveles subió, para poder avisar en el mensaje si fue más de 1.
function petAddXp(pet, amount) {
  pet.xp = (pet.xp || 0) + amount;
  pet.level = pet.level || 1;
  let levelsGained = 0;
  let needed = petXpForLevel(pet.level);
  while (pet.xp >= needed) {
    pet.xp -= needed;
    pet.level += 1;
    levelsGained += 1;
    needed = petXpForLevel(pet.level);
  }
  return levelsGained;
}

// Arma la tarjeta completa que muestra #pet (formato fijo, a prueba de datos faltantes:
// si la especie ya no existiera en el catálogo o el nombre estuviera vacío, no truena).
function formatPetCard(pet) {
  const mon = findPokemon(pet.speciesId) || { name: "???", type: null };
  const typeLabel = mon.type ? `${PET_TYPE_EMOJI[mon.type]} ${PET_TYPE_LABEL[mon.type]}` : "???";
  const rarityLabel = PET_RARITY_LABEL[pet.rarity] || "Común";
  const level = pet.level || 1;
  const needed = petXpForLevel(level);
  const { hunger, happiness } = getPetLiveStats(pet);
  const bonus = getPetBonus(pet);
  const bonusBlock = bonus.active
    ? `+${bonus.xpPct}% XP\n-${bonus.cdPct}% Cooldown`
    : `_(desactivada, sube hambre/felicidad arriba de ${PET_STAT_MIN_FOR_BONUS}%)_`;

  return (
    `*/${pet.name || "Sin nombre"}/*\n` +
    `Especie: ${mon.name}\n` +
    `Nivel: ${level}\n` +
    `XP: ${pet.xp || 0}/${needed}\n` +
    `Rareza: ${rarityLabel}\n` +
    `Tipo: ${typeLabel}\n\n` +
    `Hambre: ${hunger}%\n` +
    `Felicidad: ${happiness}%\n\n` +
    `Bonificación:\n${bonusBlock}`
  );
}

// Etapas de crecimiento de un hijo según su edad real (todo derivado de bornAt, nunca
// se guarda la etapa a mano: así nunca se desincroniza aunque el hijo esté en 2 perfiles).
const KID_STAGES = [
  { key: "bebe", label: "Bebé", minDays: 0, maxDays: 3, cooldownDeltaMs: 10 * 1000 },
  { key: "nino", label: "Niño", minDays: 3, maxDays: 13, cooldownDeltaMs: 5 * 1000 },
  { key: "adolescente", label: "Adolescente", minDays: 13, maxDays: 30, cooldownDeltaMs: 0 },
  { key: "adulto", label: "Adulto", minDays: 30, maxDays: Infinity, cooldownDeltaMs: -10 * 1000 },
];
// Piso mínimo: ningún cooldown puede quedar por debajo de esto sin importar cuántos
// hijos adultos + ventajas de la tienda se combinen.
const KID_COOLDOWN_FLOOR_MS = 5 * 1000;
const KID_MAX = 3;
const KID_PREG_CD = 24 * 60 * 60 * 1000; // 1 día

// ── #pvsp / #acceptvs ──
const PVSP_CD = 30 * 1000; // al terminar la batalla, para AMBOS participantes
const PET_LEVEL_CHALLENGE_RANGE = 5; // diferencia de nivel máxima permitida para retar
const PVSP_LEVEL_ADJUST_PER_LEVEL = 2; // % de ajuste a la probabilidad por cada nivel de diferencia
const PVSP_WIN_XP = [20, 35];
const PVSP_LOSE_XP = [5, 10];

// Probabilidad de que GANE quien tiene "myPet" contra "otherPet": empieza de la
// relación de tipos (mega counter/counter/neutral/anti-counter/mega anti-counter),
// se ajusta ±10% máx. por diferencia de nivel, y se recorta siempre entre 10%-90%
// para que nunca exista una pelea 100% segura ni 100% perdida.
function computePvspWinChance(myPet, otherPet) {
  const myType = findPokemon(myPet.speciesId)?.type;
  const otherType = findPokemon(otherPet.speciesId)?.type;
  const relation = petTypeRelation(myType, otherType);
  let chance = (PET_TYPE_WIN_CHANCE[relation] ?? 0.5) * 100;
  const levelDiff = (myPet.level || 1) - (otherPet.level || 1);
  const adjustment = Math.max(-10, Math.min(10, levelDiff * PVSP_LEVEL_ADJUST_PER_LEVEL));
  chance = Math.max(10, Math.min(90, chance + adjustment));
  return chance / 100;
}

function getKidStage(bornAt) {
  const ageDays = Math.floor((Date.now() - bornAt) / (24 * 60 * 60 * 1000));
  const stage = KID_STAGES.find(s => ageDays >= s.minDays && ageDays < s.maxDays) || KID_STAGES[KID_STAGES.length - 1];
  return { ...stage, ageDays };
}

// Suma el ajuste de cooldown de TODOS los hijos de un perfil a un cooldown base (en ms),
// respetando el piso mínimo. Se aplica DESPUÉS del descuento de la ventaja "Cooldown".
function applyKidsCooldownAdjustment(baseMs, prof) {
  const kids = prof?.kids || [];
  if (!kids.length) return baseMs;
  const totalDelta = kids.reduce((sum, kid) => sum + getKidStage(kid.bornAt).cooldownDeltaMs, 0);
  return Math.max(KID_COOLDOWN_FLOOR_MS, baseMs + totalDelta);
}

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function fmtM(n) { return `${Math.round(n).toLocaleString("es-MX")}¥`; }

// Formatea un timestamp numérico (Date.now()) como fecha legible en es-MX.
// Acepta null/undefined/valores raros sin tronar (para grupos/perfiles viejos
// que no tenían este campo antes de agregarse).
function formatDateEs(ts) {
  if (!ts || typeof ts !== "number") return "desconocida";
  return new Date(ts).toLocaleDateString("es-MX", { timeZone: "America/Mexico_City" });
}

function formatDateTimeEs(ts) {
  if (!ts || typeof ts !== "number") return "nunca";
  const d = new Date(ts);
  return `${d.toLocaleDateString("es-MX", { timeZone: "America/Mexico_City" })} ${d.toLocaleTimeString("es-MX", { timeZone: "America/Mexico_City" })}`;
}

// ══════════════════════════════
//    EFECTOS SECRETOS TEMPORALES (#jinx, #echo, #curseword, #mirror)
// ══════════════════════════════
// db.secretEffects[groupId][num] = { jinx, echoUntil, curseword: {word, until}, mirror: {remaining} }
function getSecretEffects(db, groupId, num) {
  db.secretEffects = db.secretEffects || {};
  db.secretEffects[groupId] = db.secretEffects[groupId] || {};
  db.secretEffects[groupId][num] = db.secretEffects[groupId][num] || {};
  return db.secretEffects[groupId][num];
}

// Revisa y CONSUME (una sola vez) el jinx de esa persona en ese grupo. Se llama
// justo antes de decidir si gana o pierde en cualquier comando de apuesta/riesgo.
function consumeJinx(db, groupId, num) {
  const eff = db.secretEffects?.[groupId]?.[num];
  if (eff?.jinx) {
    eff.jinx = false;
    return true;
  }
  return false;
}

// Suerte (#setluck, comando secreto): si está activa, sobreescribe la probabilidad
// de que salga BIEN en TODO lo basado en azar (apuestas, riesgo, batallas de mascota).
// Devuelve una fracción 0-1, o null si no hay nada activo (se usan las probabilidades
// normales de cada comando). #jinx sigue teniendo prioridad sobre esto en todos lados:
// es una acción deliberada dirigida a una persona, así que gana sobre cualquier ajuste
// de suerte (global o de usuario).
//
// Hay dos capas, guardadas así en la DB:
//   db.globalLuckPct = pct                                → afecta a TODOS, en TODOS los grupos.
//   db.userLuckPct[num] = { all: pct, groups: {gid: pct} } → afecta solo a ESE usuario:
//       "all" si aplica en todos sus grupos, o "groups[gid]" si es solo en uno específico.
// Prioridad: suerte de usuario en ESE grupo > suerte de usuario en todos sus grupos >
// suerte global > probabilidad normal del comando.
function getGlobalLuckGoodChance(db) {
  return (typeof db.globalLuckPct === "number") ? db.globalLuckPct / 100 : null;
}

function getUserLuckGoodChance(db, groupId, num) {
  const u = db.userLuckPct?.[num];
  if (!u) return null;
  if (typeof u.groups?.[groupId] === "number") return u.groups[groupId] / 100;
  if (typeof u.all === "number") return u.all / 100;
  return null;
}

function getEffectiveLuckGoodChance(db, groupId, num) {
  const userLuck = getUserLuckGoodChance(db, groupId, num);
  return userLuck !== null ? userLuck : getGlobalLuckGoodChance(db);
}

// Para comandos tipo "% de que salga BIEN" (cf, steal, pvsp...): si hay suerte
// activa (de usuario o global) la reemplaza; si no, usa la probabilidad normal del comando.
function goodChanceWithLuck(db, groupId, num, defaultGoodChance) {
  const luck = getEffectiveLuckGoodChance(db, groupId, num);
  return luck !== null ? luck : defaultGoodChance;
}

// Para comandos tipo "% de que salga MAL" (dungeon, ritual, adventure, slut, crime...):
// la suerte se invierte (más suerte = menos probabilidad de que salga mal).
function badChanceWithLuck(db, groupId, num, defaultBadChance) {
  const luck = getEffectiveLuckGoodChance(db, groupId, num);
  return luck !== null ? (1 - luck) : defaultBadChance;
}

// OwOificación local simple (sin depender de ninguna API externa, porque #echo la
// necesita en CADA mensaje mientras esté activo): l/r -> w, respetando mayúsculas.
function owoifyText(text) {
  return text.replace(/l/g, "w").replace(/r/g, "w").replace(/L/g, "W").replace(/R/g, "W");
}

// Versión completa para el comando público #owoify (probé la API real de PurrBot
// y ahora mismo responde 400 hasta con texto simple, así que mejor 100% local:
// reemplazo de palabras + tartamudeo + emoticonos, sin depender de nada externo).
const OWOIFY_WORD_REPLACEMENTS = {
  love: "wuv", you: "chu", the: "da", this: "dis", little: "wittle",
  cute: "kawaii~", hello: "hewwo", stupid: "baka", friend: "fwend",
  amor: "wuv~", pequeño: "pequeñito", hola: "howa", que: "qwe",
};
const OWOIFY_EMOTICONS = ["(・`ω´・)", ";;w;;", "owo", "UwU", "(´・ω・`)", ">w<", "^w^"];

function owoifyFull(text) {
  let out = text.replace(/\b\w+\b/g, (word) => {
    const lower = word.toLowerCase();
    if (OWOIFY_WORD_REPLACEMENTS[lower]) {
      const rep = OWOIFY_WORD_REPLACEMENTS[lower];
      return word[0] === word[0].toUpperCase() ? rep[0].toUpperCase() + rep.slice(1) : rep;
    }
    return word;
  });

  out = owoifyText(out);

  // Tartamudeo: ~25% de las palabras repiten su primera letra con un guión.
  out = out.replace(/\b(\w)(\w*)\b/g, (m, first, rest) => {
    if (Math.random() < 0.25) return `${first}-${first}${rest}`;
    return m;
  });

  // Emoticonos random en vez de puntuación.
  out = out.replace(/[.!?]/g, () => ` ${OWOIFY_EMOTICONS[randInt(0, OWOIFY_EMOTICONS.length - 1)]}`);

  return out;
}

// Transformación "graciosa" de #mirror: aLtErNaTiNg CaPs, tampoco depende de nada externo.
function mirrorTransform(text) {
  let out = "";
  let upper = true;
  for (const ch of text) {
    if (/[a-zA-Z]/.test(ch)) {
      out += upper ? ch.toUpperCase() : ch.toLowerCase();
      upper = !upper;
    } else {
      out += ch;
    }
  }
  return out;
}

// ══════════════════════════════
//    NUMERACIÓN PARA COMANDOS SECRETOS (#allp, #allg, #lastseen, etc.)
// ══════════════════════════════
// Perfiles ordenados por fecha de creación real (ascendente). Como las llaves de
// db.profiles son números de teléfono ("5213223783244"), JS las trata como índices
// de array y las reordena numéricamente sin importar el orden de inserción — por
// eso NO se puede usar Object.keys(db.profiles) para esto, hay que ordenar a mano
// por el timestamp guardado en createdAt.
function getSortedProfiles(db) {
  const entries = Object.entries(db.profiles || {});
  entries.sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0));
  return entries.map(([num, prof]) => ({ num, prof }));
}

// Resuelve el número de #allp (1-based) al {num, prof} correspondiente, o null.
function resolveProfileByIndex(db, index) {
  const list = getSortedProfiles(db);
  const i = parseInt(index, 10);
  if (!i || i < 1 || i > list.length) return null;
  return list[i - 1];
}

// Grupos donde un perfil tiene actividad (groupStats), en el orden guardado. Los
// jids de grupo ("...@g.us") NO son índices de array para JS, así que aquí sí se
// conserva el orden real de inserción (primera vez que interactuó ahí).
function getProfileGroupList(prof) {
  return Object.keys(prof.groupStats || {});
}

// Resuelve un número de grupo LOCAL A ESE PERFIL (el que se ve bajo su entrada en
// #allp) a uno o más groupId reales. Acepta "all". Devuelve null si el índice no
// existe para ese perfil.
function resolveProfileGroupByIndex(prof, indexOrAll) {
  const list = getProfileGroupList(prof);
  if (normalizeText(indexOrAll) === "all") return { isAll: true, groupIds: list };
  const i = parseInt(indexOrAll, 10);
  if (!i || i < 1 || i > list.length) return null;
  return { isAll: false, groupIds: [list[i - 1]] };
}

// Grupos donde está el bot AHORA MISMO, ordenados por fecha de unión (ascendente).
// Requiere sock para traer metadata en vivo (nombre actual, # de miembros, fecha
// real de creación del grupo en WhatsApp).
async function getSortedGroups(sock, db) {
  let allGroups = {};
  try {
    allGroups = await sock.groupFetchAllParticipating();
  } catch (e) {
    console.error("[ALLG] No se pudo listar los grupos:", e.message);
  }
  const ids = Object.keys(allGroups || {});
  ids.sort((a, b) => (db.groupJoinedAt?.[a] || 0) - (db.groupJoinedAt?.[b] || 0));
  return ids.map(id => ({ id, meta: allGroups[id] }));
}

// Resuelve el número de #allg (1-based, GLOBAL) al {id, meta} correspondiente.
async function resolveGroupByIndex(sock, db, index) {
  const list = await getSortedGroups(sock, db);
  const i = parseInt(index, 10);
  if (!i || i < 1 || i > list.length) return null;
  return list[i - 1];
}
function fmtCooldown(ms) {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}
// Para duraciones que pueden ser largas (AFK, etc.): días/horas/minutos en vez de solo m/s.
function fmtElapsedLong(ms) {
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "unos segundos";
}
// Desenvuelve mensajes "efímeros" (chats con mensajes temporales activados) y de una sola
// vista, ya que WhatsApp anida el contenido real un nivel más adentro en esos casos.
function unwrapMessage(m) {
  if (!m) return m;
  if (m.ephemeralMessage?.message) return unwrapMessage(m.ephemeralMessage.message);
  if (m.viewOnceMessage?.message) return unwrapMessage(m.viewOnceMessage.message);
  if (m.viewOnceMessageV2?.message) return unwrapMessage(m.viewOnceMessageV2.message);
  if (m.documentWithCaptionMessage?.message) return unwrapMessage(m.documentWithCaptionMessage.message);
  return m;
}

function normalizeText(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
}

// Distancia de Levenshtein simple, usada para darle margen de error a #trivia
// (typos, acentos raros, una letra de más/menos, etc. no deberían invalidar
// una respuesta que claramente es la correcta).
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

// Compara la respuesta de alguien contra la respuesta correcta (ya normalizada)
// con un margen de error que escala con el largo de la respuesta, para que
// pequeños typos (una letra de más/menos o cambiada) no invaliden un acierto.
function answerCloseEnough(userText, normalizedCorrectAnswer) {
  const u = normalizeText(userText);
  if (!u) return false;
  if (u === normalizedCorrectAnswer) return true;
  const maxDist = normalizedCorrectAnswer.length <= 4 ? 1 : normalizedCorrectAnswer.length <= 8 ? 2 : 3;
  return levenshtein(u, normalizedCorrectAnswer) <= maxDist;
}

// Determina si el género registrado es masculino, femenino, o desconocido (null)
function genderSuffix(prof) {
  const g = normalizeText(prof?.gender || "");
  if (!g) return null;
  const masc = ["masculino", "hombre", "chico", "varon", "male", "m", "el"];
  const fem  = ["femenino", "mujer", "chica", "female", "f", "ella"];
  if (masc.includes(g)) return "m";
  if (fem.includes(g)) return "f";
  return null;
}

// Conjuga una palabra base terminada en "o" (ej: "Casado") según el género del perfil.
// Sin género registrado, devuelve la forma neutra "X/a" (ej: "Casado/a").
function genderWord(prof, mascBase) {
  const suf = genderSuffix(prof);
  if (suf === "f") return mascBase.slice(0, -1) + "a";
  if (suf === "m") return mascBase;
  return mascBase + "/a";
}

// Palabras con marca de género que aparecen en las frases de #hug, #kiss, etc (ANIME_SOLO/PAIR).
// Todas están escritas en su forma masculina por defecto; si el perfil de quien ejecuta
// la acción es femenino, se les cambia la "o" final por "a". Sin perfil (o sin género
// registrado), se dejan tal cual, en masculino.
const GENDERED_WORDS = ["solo", "confundido", "dormido", "furioso", "nervioso", "aterrado", "tímido", "agotado", "enamorado"];
const GENDERED_WORDS_REGEX = new RegExp(`\\b(${GENDERED_WORDS.join("|")})\\b`, "gi");

function resolveGenderedText(text, db, num) {
  const prof = db.profiles?.[num];
  const suf = genderSuffix(prof);
  if (suf !== "f") return text; // masculino ya es la forma base escrita en el texto
  return text.replace(GENDERED_WORDS_REGEX, (match) => match.slice(0, -1) + "a");
}

// Economía LOCAL por grupo: wallet, banco, cooldowns y ventajas viven dentro de cada grupo/chat.
function getEco(db, groupId, num) {
  db.economy = db.economy || {};
  db.economy[groupId] = db.economy[groupId] || {};
  if (!db.economy[groupId][num]) {
    db.economy[groupId][num] = {
      wallet: 0,
      bank: 0,
      lastWork: 0,
      lastCrime: 0,
      lastSteal: 0,
      lastDaily: 0,
      lastCf: 0,
      lastRt: 0,
      lastSlots: 0,
      lastDice: 0,
      lastDungeon: 0,
      lastRitual: 0,
      lastAdventure: 0,
      lastSlut: 0,
      dailyStreak: 0,
      lastActive: Date.now(),
      advantages: { ganancia: false, cooldown: false, suerte: false, durabilidad: false, inmortal: false, botin: false, maestria: false, grind: false },
      bankTier: 0,
      hourlyBetTotal: 0,
      hourlyBetWindowStart: 0,
    };
  }
  return db.economy[groupId][num];
}

// Devuelve el tope de banco actual del jugador en este grupo (sube comprando mejoras en #shop banco).
function getBankCap(eco) {
  const tier = BANK_UPGRADES[(eco.bankTier || 0) - 1];
  return tier ? tier.cap : ECO.BANK_CAP;
}

// Revisa/registra cuánto ha apostado el jugador en la última hora (#cf, #rt, #slots, #dice).
// Devuelve cuánto le queda disponible ANTES de aplicar la apuesta actual (no la descuenta).
function getHourlyBetRoom(eco) {
  const now = Date.now();
  if (!eco.hourlyBetWindowStart || now - eco.hourlyBetWindowStart >= ECO.BET_HOURLY_WINDOW_MS) {
    eco.hourlyBetWindowStart = now;
    eco.hourlyBetTotal = 0;
  }
  return ECO.BET_HOURLY_CAP - (eco.hourlyBetTotal || 0);
}

// Suma una apuesta ya validada al contador de la hora en curso.
function addHourlyBet(eco, amount) {
  eco.hourlyBetTotal = (eco.hourlyBetTotal || 0) + amount;
}

// Inventario GLOBAL: títulos y objetos son del usuario en cualquier grupo, no se duplican por grupo.
function getInv(db, num) {
  db.inventory = db.inventory || {};
  if (!db.inventory[num]) {
    db.inventory[num] = {
      titles: [],
      equippedTitle: null,
      items: [],
      equippedItems: [],
      customTitleName: null,
    };
  }
  return db.inventory[num];
}

// Calcula el cooldown EFECTIVO de un comando de economía, en este orden fijo:
// 1) -50% si tiene la ventaja "Cooldown" de la tienda
// 2) -X% según la bonificación activa de su mascota (0% si hambre/felicidad ≤50%)
// 3) +/- los segundos de cada hijo según su etapa, con piso mínimo (KID_COOLDOWN_FLOOR_MS)
// "prof" es opcional: si no se pasa (o la persona no tiene perfil), se salta 2) y 3).
function ecoCooldown(eco, base, prof) {
  let ms = eco.advantages?.cooldown ? Math.floor(base / 2) : base;
  if (prof?.pet) {
    const bonus = getPetBonus(prof.pet);
    if (bonus.active && bonus.cdPct > 0) ms = Math.floor(ms * (1 - bonus.cdPct / 100));
  }
  if (prof?.kids?.length) ms = applyKidsCooldownAdjustment(ms, prof);
  return Math.max(1000, ms);
}

// ══════════════════════════════
//    #GRIND (ventaja de tienda): corre de un jalón todas las actividades de
//    economía "simples" (#w, #crime, #dungeon, #ritual, #adventure, #slut) que ya
//    no tengan cooldown. Se separa en 2 pasos (isGrindActivityReady + runGrindActivity)
//    a propósito: si se revisara y ejecutara una por una en el mismo loop, el efecto
//    de "delay a todos los cooldowns" de #adventure podría invalidar retroactivamente
//    a una actividad que ya estaba lista ANTES de empezar el #grind.
// ══════════════════════════════
const GRIND_ACTIVITIES = [
  { label: "Work", cd: () => ECO.WORK_CD, lastField: "lastWork", min: ECO.WORK_MIN, max: ECO.WORK_MAX },
  { label: "Crime", cd: () => ECO.CRIME_CD, lastField: "lastCrime", min: ECO.CRIME_MIN, max: ECO.CRIME_MAX, failChance: ECO.CRIME_FAIL_CHANCE, failType: "range", failMin: ECO.CRIME_FAIL_MIN, failMax: ECO.CRIME_FAIL_MAX },
  { label: "Dungeon", cd: () => ECO.DUNGEON_CD, lastField: "lastDungeon", min: ECO.DUNGEON_MIN, max: ECO.DUNGEON_MAX, failChance: ECO.DUNGEON_DEATH_CHANCE, failType: "pctWallet", failPct: ECO.DUNGEON_DEATH_LOSS_PCT },
  { label: "Ritual", cd: () => ECO.RITUAL_CD, lastField: "lastRitual", min: ECO.RITUAL_MIN, max: ECO.RITUAL_MAX, failChance: ECO.RITUAL_ABSORB_CHANCE, failType: "pctTotal", failPct: ECO.RITUAL_ABSORB_LOSS_PCT },
  { label: "Adventure", cd: () => ECO.ADVENTURE_CD, lastField: "lastAdventure", min: ECO.ADVENTURE_MIN, max: ECO.ADVENTURE_MAX, failChance: ECO.ADVENTURE_EVENT_CHANCE, failType: "delay", delayMs: ECO.ADVENTURE_DELAY_MS },
  { label: "Slut", cd: () => ECO.SLUT_CD, lastField: "lastSlut", min: ECO.SLUT_MIN, max: ECO.SLUT_MAX, failChance: ECO.SLUT_FAIL_CHANCE, failType: "range", failMin: ECO.SLUT_FAIL_MIN, failMax: ECO.SLUT_FAIL_MAX },
];

function isGrindActivityReady(eco, prof, cfg) {
  const cd = ecoCooldown(eco, cfg.cd(), prof);
  return (Date.now() - (eco[cfg.lastField] || 0)) >= cd;
}

function runGrindActivity(db, from, senderNum, cfg) {
  const eco = getEco(db, from, senderNum);
  const now = Date.now();
  eco[cfg.lastField] = now;
  eco.lastActive = now;

  if (cfg.failChance !== undefined) {
    const failed = consumeJinx(db, from, senderNum) || Math.random() < badChanceWithLuck(db, from, senderNum, cfg.failChance);
    if (failed) {
      if (cfg.failType === "delay") {
        const delay = eco.advantages?.cooldown ? Math.floor(cfg.delayMs / 2) : cfg.delayMs;
        for (const field of ECO_COOLDOWN_FIELDS) eco[field] = (eco[field] || 0) + delay;
        return { label: cfg.label, ok: false, text: `+${fmtCooldown(delay)} a cooldowns` };
      }
      let loss;
      if (cfg.failType === "pctWallet") {
        loss = Math.round(eco.wallet * cfg.failPct);
        eco.wallet -= loss;
      } else if (cfg.failType === "pctTotal") {
        const total = eco.wallet + eco.bank;
        loss = Math.round(total * cfg.failPct);
        const fromWallet = Math.min(eco.wallet, loss);
        eco.wallet -= fromWallet;
        eco.bank -= (loss - fromWallet);
      } else {
        loss = Math.min(randInt(cfg.failMin, cfg.failMax), eco.wallet);
        eco.wallet -= loss;
      }
      return { label: cfg.label, ok: false, text: `-${fmtM(loss)}` };
    }
  }
  let amount = randInt(cfg.min, cfg.max);
  if (eco.advantages.ganancia) amount *= 2;
  eco.wallet += amount;
  return { label: cfg.label, ok: true, text: `+${fmtM(amount)}` };
}

// ─── Sistema de Niveles/XP ──────────────────────────────────────────────────
// La XP necesaria para subir de nivel crece progresivamente con cada nivel.
function xpForLevel(level) {
  return Math.floor(100 * Math.pow(level, 1.35));
}

// Suma XP al perfil global del usuario (no depende del grupo) y sube de nivel
// tantas veces como haga falta. Devuelve { leveledUp, level } para que quien
// llame decida si avisa en el chat.
function addXp(db, num, amount) {
  const prof = db.profiles?.[num];
  if (!prof || !amount) return null;
  if (typeof prof.level !== "number") prof.level = 1;
  if (typeof prof.xp !== "number") prof.xp = 0;
  prof.xp += amount;
  let leveledUp = false;
  let needed = xpForLevel(prof.level);
  while (prof.xp >= needed) {
    prof.xp -= needed;
    prof.level++;
    leveledUp = true;
    needed = xpForLevel(prof.level);
  }
  return { leveledUp, level: prof.level };
}

// Símbolos del tragamonedas (#slots), con pesos: entre más alto el peso, más común sale.
// "7" es el símbolo de jackpot, con el peso más bajo para que sea muy raro.
// Se agregaron 2 símbolos nuevos (Uva, Trébol) para repartir más la probabilidad y
// bajar la chance de que salgan 2 o 3 iguales (gana menos seguido que antes).
const SLOT_SYMBOLS = [
  { name: "Cereza", weight: 25 },
  { name: "Limón", weight: 20 },
  { name: "Uva", weight: 17 },
  { name: "Campana", weight: 15 },
  { name: "Trébol", weight: 12 },
  { name: "Estrella", weight: 8 },
  { name: "Diamante", weight: 5 },
  { name: "7", weight: 1.5 },
];
function pickSlotSymbol() {
  const total = SLOT_SYMBOLS.reduce((sum, s) => sum + s.weight, 0);
  let r = Math.random() * total;
  for (const s of SLOT_SYMBOLS) {
    if (r < s.weight) return s.name;
    r -= s.weight;
  }
  return SLOT_SYMBOLS[0].name;
}

// ═══════════════════════════════════════════════════════════════════════════
//    SISTEMA DE RECOLECCIÓN: MINERÍA (#mine) Y PESCA (#fish)
// ═══════════════════════════════════════════════════════════════════════════
// Todo vive DENTRO de la economía local del grupo (eco.gather), igual que el
// wallet/banco: picos, cañas, materiales y llaves son por chat, no globales.

const GATHER = {
  CD: 4 * 60 * 1000,             // cooldown base de #mine y #fish (subido de 2.5 a 4 min: menos spam, más coherente con el nerf de recompensas)
  TIP_MIN: 3000, TIP_MAX: 6000,  // dinero extra por cada uso, aparte de los materiales (nerfeado, antes 6000-11000)
  DROPS_MIN: 3, DROPS_MAX: 5,     // cuántos materiales caen por uso (nerfeado, antes 6-10)
  CHEST_CHANCE: 0.12,             // sube un poco para compensar el nerf general (antes 0.10)
  CHEST_EMPTY_CHANCE: 0.10,       // cofres vacíos menos probables (antes 0.20), para que destaquen más
  CHEST_BONUS_DROPS_MIN: 5, CHEST_BONUS_DROPS_MAX: 9, // buffeado (antes 3-6)
  CHEST_COIN_MIN: 20000, CHEST_COIN_MAX: 45000, // se multiplica por el número de zona (buffeado, antes 12000-28000)
  CHEST_GRACE_MS: 60 * 1000,      // tiempo para comprar/craftear la llave si no la tienes cuando aparece un cofre
  DEATH_CHANCE: 0.05,   // solo en #mine (subido de 0.02 a 0.05: minar ahora es más arriesgado)
  DEATH_CD: 12 * 60 * 1000,       // subido de 10 a 12 min, acorde al mayor riesgo
  DEATH_LOSS_PCT: 0.10,
  TOOL1_PRICE: 5000, TOOL1_USES: 5,
};

// Nivel 2 y 3 se craftean (dinero + materiales), nivel 1 se compra directo.
// IMPORTANTE: los materiales para craftear un nivel SIEMPRE deben poder conseguirse en zonas
// accesibles con el nivel ANTERIOR de la herramienta, para no encerrar al jugador (softlock).
const TOOL_CRAFT = {
  pico: {
    2: { money: 10000, uses: 20, fail: 0.05, materials: { hierro: 3, oro: 2 } },
    3: { money: 25000, uses: 100, fail: 0.05, materials: { netherita_bruto: 3, cristal_fin: 1 } },
  },
  cana: {
    2: { money: 10000, uses: 20, fail: 0.05, materials: { salmon: 3, pez_globo: 2 } },
    3: { money: 25000, uses: 100, fail: 0.05, materials: { escama_guardian: 2, etiqueta_nombre: 1 } },
  },
};

// Registro global de materiales: nombre a mostrar + precio de venta con #sell.
const MATERIALS = {
  // ── Minería ──
  piedra: { name: "Piedra", sell: 400, type: "mine" },
  carbon: { name: "Carbón", sell: 800, type: "mine" },
  hierro: { name: "Hierro", sell: 1550, type: "mine" },
  redstone: { name: "Redstone", sell: 2300, type: "mine" },
  oro: { name: "Oro", sell: 2750, type: "mine" },
  lapislazuli: { name: "Lapislázuli", sell: 3350, type: "mine" },
  diamante: { name: "Diamante", sell: 5400, type: "mine" },
  esmeralda: { name: "Esmeralda", sell: 7200, type: "mine" },
  cuarzo_nether: { name: "Cuarzo del Nether", sell: 6000, type: "mine" },
  obsidiana: { name: "Obsidiana", sell: 8400, type: "mine" },
  vara_blaze: { name: "Vara de Blaze", sell: 10200, type: "mine" },
  netherita_bruto: { name: "Netherita en Bruto", sell: 14400, type: "mine" },
  perla_ender: { name: "Perla de Ender", sell: 12600, type: "mine" },
  ojo_ender: { name: "Ojo de Ender", sell: 16800, type: "mine" },
  cristal_fin: { name: "Cristal del Fin", sell: 21600, type: "mine" },
  escama_dragon: { name: "Escama de Dragón", sell: 28800, type: "mine" },
  eco_sculk: { name: "Eco de Sculk", sell: 26400, type: "mine" },
  fragmento_sculk: { name: "Fragmento de Sculk", sell: 34800, type: "mine" },
  diente_warden: { name: "Diente del Warden", sell: 46800, type: "mine" },
  corazon_oscuro: { name: "Corazón Oscuro", sell: 58800, type: "mine" },
  nucleo_warden: { name: "Núcleo del Warden", sell: 90000, type: "mine" },

  // ── Pesca ──
  bota_vieja: { name: "Bota Vieja", sell: 100, type: "fish" },
  pez_crudo: { name: "Pez Crudo", sell: 700, type: "fish" },
  alga: { name: "Alga", sell: 1150, type: "fish" },
  hueso: { name: "Hueso", sell: 1550, type: "fish" },
  salmon: { name: "Salmón", sell: 2150, type: "fish" },
  pez_globo: { name: "Pez Globo", sell: 2900, type: "fish" },
  cuerda: { name: "Cuerda", sell: 1800, type: "fish" },
  pez_tropical: { name: "Pez Tropical", sell: 4300, type: "fish" },
  concha_nautilo: { name: "Concha de Nautilo", sell: 7800, type: "fish" },
  prisma_mar: { name: "Prisma de Mar", sell: 5700, type: "fish" },
  escama_guardian: { name: "Escama de Guardián", sell: 10800, type: "fish" },
  etiqueta_nombre: { name: "Etiqueta de Nombre", sell: 15000, type: "fish" },
  cristal_mar: { name: "Cristal de Mar", sell: 12000, type: "fish" },
  silla_montar: { name: "Silla de Montar", sell: 19200, type: "fish" },
  corazon_mar: { name: "Corazón del Mar", sell: 36000, type: "fish" },
  tridente: { name: "Tridente", sell: 54000, type: "fish" },
  diente_ahogado: { name: "Diente de Ahogado", sell: 27600, type: "fish" },
  ceniza_sulfurica: { name: "Ceniza Sulfúrica", sell: 33600, type: "fish" },
  nucleo_abisal: { name: "Núcleo Abisal", sell: 78000, type: "fish" },
};

function materialName(id) { return MATERIALS[id]?.name || id; }
function materialSell(id) { return MATERIALS[id]?.sell || 0; }

// 5 cuevas para #mine. minTool: nivel mínimo de pico requerido (1, 2 o 3).
const MINE_ZONES = [
  { id: 1, name: "Cueva de Piedra", minTool: 1, keyPrice: 8000,
    table: [["piedra", 50], ["carbon", 30], ["hierro", 15], ["redstone", 5]] },
  { id: 2, name: "Mina Abandonada", minTool: 1, keyPrice: 15000,
    table: [["hierro", 30], ["oro", 30], ["lapislazuli", 20], ["diamante", 15], ["esmeralda", 5]] },
  { id: 3, name: "Fortaleza del Nether", minTool: 2, keyPrice: 25000,
    table: [["cuarzo_nether", 30], ["oro", 20], ["obsidiana", 20], ["vara_blaze", 20], ["netherita_bruto", 10]] },
  { id: 4, name: "El Fin", minTool: 2, keyPrice: 40000,
    table: [["perla_ender", 30], ["ojo_ender", 25], ["cristal_fin", 20], ["netherita_bruto", 15], ["escama_dragon", 10]] },
  { id: 5, name: "Guarida del Warden", minTool: 3, keyPrice: 60000,
    table: [["eco_sculk", 30], ["fragmento_sculk", 25], ["diente_warden", 20], ["corazon_oscuro", 15], ["nucleo_warden", 10]] },
];

// 5 lagos para #fish. Sus llaves NO se compran, se craftean con materiales de minería.
const FISH_ZONES = [
  { id: 1, name: "Estanque de Aldea", minTool: 1, keyRecipe: { piedra: 5, carbon: 3 },
    table: [["bota_vieja", 10], ["pez_crudo", 45], ["alga", 25], ["hueso", 20]] },
  { id: 2, name: "Río del Bosque", minTool: 1, keyRecipe: { hierro: 5, oro: 3 },
    table: [["pez_crudo", 30], ["salmon", 30], ["pez_globo", 25], ["cuerda", 15]] },
  { id: 3, name: "Monumento Oceánico", minTool: 2, keyRecipe: { diamante: 4, cuarzo_nether: 2 },
    table: [["salmon", 25], ["pez_tropical", 25], ["concha_nautilo", 25], ["prisma_mar", 25]] },
  { id: 4, name: "Ruinas Sumergidas", minTool: 2, keyRecipe: { netherita_bruto: 3, perla_ender: 2 },
    table: [["pez_tropical", 25], ["escama_guardian", 25], ["etiqueta_nombre", 25], ["cristal_mar", 25]] },
  { id: 5, name: "Lago Sulfúrico", minTool: 3, keyRecipe: { nucleo_warden: 2, diente_warden: 3 },
    table: [["corazon_mar", 25], ["tridente", 20], ["diente_ahogado", 25], ["ceniza_sulfurica", 20], ["nucleo_abisal", 10]] },
];

function zoneList(kind) { return kind === "pico" ? MINE_ZONES : FISH_ZONES; }
function findZone(kind, id) { return zoneList(kind).find(z => z.id === id) || null; }

// Elige un material al azar respetando los pesos (probabilidades) de la zona.
function weightedPick(table) {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [id, w] of table) {
    if (r < w) return id;
    r -= w;
  }
  return table[table.length - 1][0];
}

// Inicializa (de forma perezosa) la parte de recolección dentro de la economía del grupo.
function getGather(eco) {
  if (!eco.gather) {
    eco.gather = {
      picos: [], canas: [],
      equippedPico: null, equippedCana: null,
      materials: {},
      mineKeys: {}, fishKeys: {},
      lastMine: 0, lastFish: 0,
      mineDeathUntil: 0,
      pendingChest: null, // { kind, zoneId, expiresAt } — cofre esperando a que compres/craftees la llave
    };
  }
  if (eco.gather.pendingChest === undefined) eco.gather.pendingChest = null;
  return eco.gather;
}

function toolList(g, kind) { return kind === "pico" ? g.picos : g.canas; }
function equippedKey(kind) { return kind === "pico" ? "equippedPico" : "equippedCana"; }
function toolName(kind, level) {
  const names = kind === "pico" ? ["Pico", "Pico Pro", "Pico Dios"] : ["Caña", "Caña Pro", "Caña Dios"];
  return names[level - 1] || names[0];
}

// Re-equipa automáticamente la mejor herramienta disponible (mayor nivel, luego más usos).
function autoEquipBest(g, kind) {
  const list = toolList(g, kind);
  const key = equippedKey(kind);
  if (!list.length) { g[key] = null; return; }
  let bestIdx = 0;
  for (let i = 1; i < list.length; i++) {
    const a = list[i], b = list[bestIdx];
    if (a.level > b.level || (a.level === b.level && a.usesLeft > b.usesLeft)) bestIdx = i;
  }
  g[key] = bestIdx;
}

function getEquippedTool(g, kind) {
  const list = toolList(g, kind);
  const idx = g[equippedKey(kind)];
  if (idx === null || idx === undefined || !list[idx]) return null;
  return { tool: list[idx], idx };
}

// Interpreta argumentos tipo "pico", "pico pro 3", "caña dios", "cana 2", etc.
function matchToolArgs(text) {
  const norm = normalizeText(text);
  const m = norm.match(/^(pico|cana)(?:\s+(pro|dios))?(?:\s+(\d+))?$/);
  if (!m) return null;
  const kind = m[1] === "cana" ? "cana" : "pico";
  const level = m[2] === "pro" ? 2 : m[2] === "dios" ? 3 : 1;
  const qty = m[3] ? Math.max(1, Math.min(parseInt(m[3], 10), 20)) : 1;
  return { kind, level, qty };
}

// Reparte la recompensa de un cofre ya abierto (con llave en mano).
function openChestReward(eco, g, zone) {
  if (Math.random() < GATHER.CHEST_EMPTY_CHANCE) {
    return `\n\n(¬_¬) Abriste el cofre de *${zone.name}*... pero estaba vacío kashira.`;
  }
  const bonusDrops = randInt(GATHER.CHEST_BONUS_DROPS_MIN, GATHER.CHEST_BONUS_DROPS_MAX);
  const gained = {};
  for (let i = 0; i < bonusDrops; i++) {
    const id = weightedPick(zone.table);
    gained[id] = (gained[id] || 0) + 1;
    g.materials[id] = (g.materials[id] || 0) + 1;
  }
  let coins = randInt(GATHER.CHEST_COIN_MIN, GATHER.CHEST_COIN_MAX) * zone.id;
  if (eco.advantages?.ganancia) coins *= 2;
  eco.wallet += coins;
  const text = Object.entries(gained).map(([id, qty]) => `${qty}x ${materialName(id)}`).join(", ");
  return `\n\n(ノ◕ヮ◕)ノ*:・゚✧ *¡COFRE ABIERTO EN ${zone.name.toUpperCase()}!* ✧゚・:*ヽ(◕ヮ◕ヽ)\n(★ω★) Ganaste *${fmtM(coins)}* y: ${text}.`;
}

// Si se encuentra un cofre: si el jugador ya tiene llave de esa zona, se abre al instante.
// Si NO tiene, se le da 1 minuto de gracia para comprar (#buy llave, mina) o craftear
// (#craft llave, lago) la llave y así abrirlo igual; si no llega a tiempo, el cofre se pierde.
function handleChestFound(sock, db, from, senderNum, eco, g, zone, kind) {
  const keyStore = kind === "pico" ? g.mineKeys : g.fishKeys;
  const owned = keyStore[zone.id] || 0;

  if (owned > 0) {
    keyStore[zone.id] = owned - 1;
    return openChestReward(eco, g, zone);
  }

  const expiresAt = Date.now() + GATHER.CHEST_GRACE_MS;
  g.pendingChest = { kind, zoneId: zone.id, expiresAt };

  setTimeout(async () => {
    try {
      const liveDb = loadDB();
      const liveEco = getEco(liveDb, from, senderNum);
      const liveG = getGather(liveEco);
      const pending = liveG.pendingChest;
      if (pending && pending.kind === kind && pending.zoneId === zone.id && pending.expiresAt === expiresAt) {
        liveG.pendingChest = null;
        saveDB(liveDb);
        await sock.sendMessage(from, {
          text: `[ (T_T) ] @${senderNum} tu cofre de *${zone.name}* se esfumó porque no conseguiste la llave a tiempo kashira.`,
          mentions: [senderNum + "@s.whatsapp.net"]
        });
      }
    } catch (e) {
      console.error("[COFRE] Error en el timeout de gracia:", e.message);
    }
  }, GATHER.CHEST_GRACE_MS);

  const howTo = kind === "pico" ? `#buy llave ${zone.id}` : `#craft llave ${zone.id}`;
  return `\n\n(⊙ω⊙) *¡COFRE ENCONTRADO EN ${zone.name.toUpperCase()}!* (⊙ω⊙)\n(°Δ°) No tienes la llave kashira... ¡tienes *1 minuto* para conseguirla! Usa \`${howTo}\` antes de que se esfume.`;
}

function formatToolsInv(g) {
  const eqPico = getEquippedTool(g, "pico");
  const eqCana = getEquippedTool(g, "cana");
  const picosText = g.picos.length
    ? g.picos.map((t, i) => `${toolName("pico", t.level)} (${t.usesLeft} usos)${eqPico?.idx === i ? " [equipado]" : ""}`).join(", ")
    : "Ninguno";
  const canasText = g.canas.length
    ? g.canas.map((t, i) => `${toolName("cana", t.level)} (${t.usesLeft} usos)${eqCana?.idx === i ? " [equipada]" : ""}`).join(", ")
    : "Ninguna";
  return `(⌐■_■) *Picos:* ${picosText}\n(⌐■_■) *Cañas:* ${canasText}`;
}

function formatMaterialsInv(g) {
  const entries = Object.entries(g.materials || {}).filter(([, qty]) => qty > 0);
  if (!entries.length) return "(._.) *Materiales:* Ninguno";
  return "(._.) *Materiales:* " + entries.map(([id, qty]) => `${qty}x ${materialName(id)}`).join(", ");
}

// ─── Textos de referencia: #tools, #zones, #mats, #keys ─────
function buildHerramientasText() {
  const picoPro = TOOL_CRAFT.pico[2], picoDios = TOOL_CRAFT.pico[3];
  const canaPro = TOOL_CRAFT.cana[2], canaDios = TOOL_CRAFT.cana[3];
  const matsText = (req) => Object.entries(req.materials).map(([id, need]) => `${need}x ${materialName(id)}`).join(" + ");

  return `*⌞ Herramientas ⌝*
━━━━━━━━━━━━━━━━
*Pico* — ${fmtM(GATHER.TOOL1_PRICE)} | ${GATHER.TOOL1_USES} usos
Se compra directo: #buy pico [cantidad]
──
*Pico Pro* — ${fmtM(picoPro.money)} + ${matsText(picoPro)} | ${picoPro.uses} usos | ${Math.round(picoPro.fail * 100)}% de fallo por unidad
Se craftea: #buy pico pro [cantidad]
──
*Pico Dios* — ${fmtM(picoDios.money)} + ${matsText(picoDios)} | ${picoDios.uses} usos | ${Math.round(picoDios.fail * 100)}% de fallo por unidad
Se craftea: #buy pico dios [cantidad]
━━━━━━━━━━━━━━━━
*Caña* — ${fmtM(GATHER.TOOL1_PRICE)} | ${GATHER.TOOL1_USES} usos
Se compra directo: #buy caña [cantidad]
──
*Caña Pro* — ${fmtM(canaPro.money)} + ${matsText(canaPro)} | ${canaPro.uses} usos | ${Math.round(canaPro.fail * 100)}% de fallo por unidad
Se craftea: #buy caña pro [cantidad]
──
*Caña Dios* — ${fmtM(canaDios.money)} + ${matsText(canaDios)} | ${canaDios.uses} usos | ${Math.round(canaDios.fail * 100)}% de fallo por unidad
Se craftea: #buy caña dios [cantidad]
━━━━━━━━━━━━━━━━
_Al comprar/craftear se auto-equipa la mejor que tengas. Cambia manualmente con #equip pico/caña [pro/dios]. Los materiales se gastan aunque el crafteo falle kashira._`;
}

function buildZonasText() {
  const pct = (w, total) => Math.round((w / total) * 100);
  const zoneBlock = (zone, kind) => {
    const total = zone.table.reduce((s, [, w]) => s + w, 0);
    const matsText = zone.table.map(([id, w]) => `${materialName(id)} (${pct(w, total)}%)`).join(", ");
    const keyText = kind === "pico"
      ? `Llave: ${fmtM(zone.keyPrice)} con #buy llave ${zone.id}`
      : `Llave: craftear con #craft llave ${zone.id} (${Object.entries(zone.keyRecipe).map(([id, need]) => `${need}x ${materialName(id)}`).join(", ")})`;
    return `*${zone.id}. ${zone.name}* — requiere ${toolName(kind, zone.minTool)}\nMateriales: ${matsText}\n${keyText}`;
  };

  const mineText = MINE_ZONES.map(z => zoneBlock(z, "pico")).join("\n──\n");
  const fishText = FISH_ZONES.map(z => zoneBlock(z, "cana")).join("\n──\n");

  return `*⌞ Zonas de Minería (#mine) ⌝*
━━━━━━━━━━━━━━━━
${mineText}
━━━━━━━━━━━━━━━━
*⌞ Zonas de Pesca (#fish) ⌝*
━━━━━━━━━━━━━━━━
${fishText}
━━━━━━━━━━━━━━━━
_Usa #mine [zona] o #fish [zona] para elegir. Sin número, se usa la zona 1._`;
}

function buildMaterialesText() {
  const mineList = Object.values(MATERIALS).filter(m => m.type === "mine");
  const fishList = Object.values(MATERIALS).filter(m => m.type === "fish");
  const fmtList = (list) => list.map(m => `${m.name} — ${fmtM(m.sell)}`).join("\n");

  return `*⌞ Materiales ⌝*
━━━━━━━━━━━━━━━━
*Minería:*
${fmtList(mineList)}
━━━━━━━━━━━━━━━━
*Pesca:*
${fmtList(fishList)}
━━━━━━━━━━━━━━━━
_Véndelos con #sell [material] [cantidad|all] kashira._`;
}

function buildLlavesText() {
  const mineKeys = MINE_ZONES.map(z => `Zona ${z.id} (${z.name}): ${fmtM(z.keyPrice)}`).join("\n");
  const fishKeys = FISH_ZONES.map(z => `Zona ${z.id} (${z.name}): ${Object.entries(z.keyRecipe).map(([id, need]) => `${need}x ${materialName(id)}`).join(", ")}`).join("\n");

  return `*⌞ Llaves ⌝*
━━━━━━━━━━━━━━━━
*Llaves de mina* — se compran con #buy llave [zona], dinero del banco:
${mineKeys}
──
*Llaves de lago* — se craftean con #craft llave [zona], usando materiales de minería:
${fishKeys}
━━━━━━━━━━━━━━━━
_12% de probabilidad de encontrar un cofre al minar/pescar; si tienes la llave de esa zona se abre solo (10% de que esté vacío). Si no tienes llave, tienes 1 minuto para comprarla/craftearla antes de que el cofre se pierda._`;
}

const WORK_TEXTS = [
  "Ganaste la lotería, pero apostaste el 99% y perdiste. Te quedaste con {amount}.",
  "Vendiste tus datos personales a una empresa random y te pagaron {amount}.",
  "Trabajaste horas extra que nadie te pidió... y solo cobraste {amount}.",
  "Encontraste un billete en la calle, el cajero no notó que era falso: {amount}.",
  "Le hiciste la tarea a alguien por dinero, ni las gracias te dio: {amount}.",
  "Participaste en un estudio médico experimental y sobreviviste, cobrando {amount}.",
  "Reciclaste botellas todo el día como si tu vida dependiera de ello: {amount}.",
  "Tu jefe te subió el sueldo por error, cobra rápido antes de que se dé cuenta: {amount}.",
  "Vendiste tu opinión en una encuesta pagada: {amount}.",
  "Repartiste comida bajo la lluvia por propinas de lástima: {amount}.",
];

const CRIME_WIN_TEXTS = [
  "Le robaste el celular a un anciano distraído: {amount}.",
  "Vendiste información falsa a un espía ruso: {amount}.",
  "Hackeaste la cuenta bancaria de tu vecino: {amount}.",
  "Le vendiste un Rolex de juguete a un turista: {amount}.",
  "Clonaste tarjetas en el cajero del centro comercial: {amount}.",
  "Sobornaste a un policía y encima te dio cambio: {amount}.",
  "Organizaste una rifa que nunca existió: {amount}.",
];

const CRIME_FAIL_TEXTS = [
  "Te atraparon las cámaras de seguridad y pagaste la fianza: -{amount}.",
  "El anciano resultó ser ex-luchador y te dejó pagando el hospital: -{amount}.",
  "La policía te encontró antes de escapar, adiós ahorros: -{amount}.",
  "Tu cómplice te delató por la recompensa: -{amount}.",
  "El 'Rolex' se lo vendiste a un policía encubierto: -{amount}.",
  "El plan salió mal desde el principio, terminaste pagando daños: -{amount}.",
];

const DUNGEON_TEXTS = [
  "Limpiaste la mazmorra entera sin un rasguño y saqueaste el cofre final: {amount}.",
  "Un slime te escupió encima pero al menos soltó buen botín: {amount}.",
  "Le ganaste al jefe de la mazmorra en su primer intento: {amount}.",
  "Encontraste un pasadizo secreto lleno de monedas antiguas: {amount}.",
  "Sobreviviste a la trampa de flechas por pura suerte y cobraste: {amount}.",
  "Los goblins de la entrada ni te vieron llegar: {amount}.",
];

const DUNGEON_DEATH_TEXTS = [
  "Un dragón novato te confundió con su cena y perdiste {amount} en gastos médicos.",
  "Caíste en una trampa de picos que definitivamente no viste venir: -{amount}.",
  "El jefe final resultó ser mucho más fuerte de lo esperado: -{amount}.",
  "Te perdiste en la mazmorra y tuviste que pagar un rescate para salir: -{amount}.",
  "Un esqueleto te robó la cartera antes de que lograras derrotarlo: -{amount}.",
];

const RITUAL_TEXTS = [
  "El ritual salió perfecto y el portal escupió una lluvia de monedas: {amount}.",
  "Invocaste algo que ni entendiste, pero te pagó bien por dejarlo ir: {amount}.",
  "El círculo brilló, las velas no explotaron y ganaste: {amount}.",
  "Le vendiste tu voz (la recuperaste después) a cambio de: {amount}.",
  "El altar aceptó tu ofrenda y te devolvió el triple: {amount}.",
];

const RITUAL_ABSORB_TEXTS = [
  "El portal se abrió más de lo planeado y te absorbió parte de tu dinero: -{amount}.",
  "Invocaste a la entidad equivocada y te cobró una 'comisión': -{amount}.",
  "El círculo de invocación falló y el vórtice se llevó tus ahorros: -{amount}.",
  "Algo del otro lado no estaba contento con tu ofrenda: -{amount}.",
];

const ADVENTURE_TEXTS = [
  "La aventura salió sin contratiempos y volviste con: {amount}.",
  "Ayudaste a un aldeano perdido y te recompensó con: {amount}.",
  "Encontraste un cofre abandonado en el camino: {amount}.",
  "Cruzaste el bosque sin problemas y cobraste tu recompensa: {amount}.",
  "Derrotaste a unos bandidos de poca monta y te quedaste con: {amount}.",
];

const ADVENTURE_DELAY_TEXTS = [
  "Te perdiste siguiendo un mapa mal dibujado y perdiste tiempo kashira.",
  "Un puente colgante se rompió a la mitad y tuviste que dar la vuelta larga.",
  "Te distrajiste con un NPC random que no paraba de hablar de su vida.",
  "Una tormenta repentina te obligó a resguardarte varias horas.",
  "Confundiste el camino de regreso y diste vueltas sin sentido.",
];

const SLUT_TEXTS = [
  "Coqueteaste con la persona equivocada y salió generoso: {amount}.",
  "Vendiste 'contenido exclusivo' en línea y te pagaron: {amount}.",
  "Un admirador secreto te transfirió sin preguntar nada: {amount}.",
  "Hiciste unas cuantas 'llamadas privadas' y cobraste: {amount}.",
  "Alguien pagó bien por tu compañía esta noche: {amount}.",
];

const SLUT_FAIL_TEXTS = [
  "El administrador del grupo te pidió 'servicios de moderación premium' y terminaste pagándole tú: -{amount}.",
  "Intentaste coquetear con el owner del bot y te cobró consultoría VIP no solicitada: -{amount}.",
  "Un admin te bloqueó a mitad de la 'negociación' y perdiste el anticipo: -{amount}.",
  "El owner del bot dijo que 'no acepta pagos en especie' y aun así te cobró: -{amount}.",
  "Terminaste debiéndole favores al staff del grupo, salió carísimo: -{amount}.",
  "Un admin aburrido te vendió una app fitness que nunca abriste: -{amount}.",
];

const STEAL_SUCCESS_TEXTS = [
  "Aprovechaste que @{target} estaba distraído y le vaciaste los bolsillos.",
  "Te colaste en la casa de @{target} y saliste con el dinero en la mano.",
  "@{target} nunca notó cuando le sacaste la cartera.",
];

const STEAL_FAIL_TEXTS = [
  "Intentaste robarle a @{target}, pero te descubrió a tiempo.",
  "@{target} se despertó justo cuando ibas a escapar con el dinero.",
  "El plan para robarle a @{target} se fue directo al caño.",
];

const GIVE_SCOLD_TEXTS = [
  "¿En serio vas a hacer trampa así kashira? Ni siquiera te da vergüenza...",
  "Esto rompe toda la economía que con tanto esfuerzo diseñé, pero bueno, tú mandas kashira °﹏°",
  "No es como si me importara que hagas trampa ni nada... pero sí me importa, kashira ¬_¬",
  "Solo porque eres mi owner no significa que puedas abusar así de mí, kashira...",
  "Voy a fingir que no vi esto, pero lo vi, kashira. Guardaré silencio... por ahora.",
  "Espero que sea solo para pruebas, o te las verás conmigo kashira °﹏°",
  "Qué fácil te la pones a ti mismo, ¿no kashira? Ojalá los demás pudieran hacer trampa también.",
];

// ═══════════════════════════════════════════════════════════════════════════
//    JUEGOS: #8BALL, #TRIVIA, #MATH, #WOULDYOURATHER
// ═══════════════════════════════════════════════════════════════════════════
// Los retos con respuesta (#trivia y #math) viven en memoria, no en la DB:
// es un estado efímero por grupo, si el bot se reinicia a la mitad simplemente
// se pierde el reto activo y ya, no hace falta persistirlo entre sesiones.
const pendingChallenges = {}; // { [groupId]: { type: "trivia"|"math", answer, reward, timeout } }
const CHALLENGE_TIMEOUT_MS = 30 * 1000;
// Antes #math no tenía NINGÚN cooldown: se podía spamear sin límite y como es una
// operación simple (resoluble con calculadora en segundos), era básicamente una
// máquina de imprimir dinero. Ahora ambos comparten un cooldown por grupo.
const CHALLENGE_COOLDOWN_MS = 2 * 60 * 1000;
// #math: subido bastante — antes el premio (4,000-9,000¥) era más bajo que ganar
// con #work sin ningún riesgo, así que nadie se arriesgaba a competir por si alguien
// más respondía primero. Ahora paga claramente más que las opciones seguras, para
// que valga la pena competir por él.
const CHALLENGE_REWARD_MIN = 15000, CHALLENGE_REWARD_MAX = 30000;
// #trivia: la XP se bajó MUCHO (antes 40-90, subía de nivel carísimo rápido incluso
// aunque el nivel es cosmético — igual se sentía roto ver el nivel dispararse).
// Ahora es solo un empujoncito de bono, comparable a unos cuantos comandos normales.
const TRIVIA_XP_MIN = 8, TRIVIA_XP_MAX = 15;
// El dinero de trivia se sube un poco más que #math (mismo riesgo de que alguien más
// conteste primero, pero encima requiere saber la respuesta de verdad).
const TRIVIA_REWARD_MIN = 18000, TRIVIA_REWARD_MAX = 35000;

function clearChallenge(groupId) {
  const c = pendingChallenges[groupId];
  if (c?.timeout) clearTimeout(c.timeout);
  delete pendingChallenges[groupId];
}

// Selección de #lyrics cuando hay varias coincidencias: también en memoria,
// solo la persona que hizo la búsqueda puede elegir, y expira solo.
const pendingLyrics = {}; // { [groupId]: { requester, options: [{artist,title}], timeout } }
const LYRICS_SELECT_TIMEOUT_MS = 45 * 1000;

function clearLyricsPending(groupId) {
  const c = pendingLyrics[groupId];
  if (c?.timeout) clearTimeout(c.timeout);
  delete pendingLyrics[groupId];
}

const EIGHTBALL_ANSWERS = [
  "Sí, kashira (o^-')b",
  "Definitivamente sí kashira (*^.^*)",
  "Sin ninguna duda kashira ✧",
  "No kashira (¬_¬)",
  "Definitivamente no kashira (x_x)",
  "Lo dudo mucho kashira (・_・;)",
  "Pregúntame de nuevo más tarde kashira...",
  "No puedo predecir eso ahora kashira (._.)",
  "Concéntrate y vuelve a preguntar kashira.",
  "Las señales apuntan a que sí kashira (^w^)",
  "Las señales apuntan a que no kashira (¬‿¬)",
  "Es mejor que no te diga kashira ( ⁠｡⁠•̀⁠ᴗ⁠-⁠)⁠✧",
  "Muy probable kashira!",
  "No cuentes con ello kashira (¬_¬)",
];

const WOULDYOURATHER_QUESTIONS = [
  "¿Preferirías tener el poder de volar o ser invisible?",
  "¿Preferirías vivir sin música o sin internet?",
  "¿Preferirías saber cuándo vas a morir o cómo vas a morir?",
  "¿Preferirías perder todos tus recuerdos o no poder crear ninguno nuevo?",
  "¿Preferirías ser el más inteligente o el más atractivo del grupo?",
  "¿Preferirías viajar al pasado o al futuro?",
  "¿Preferirías tener a Beatrice como bibliotecaria o como maestra kashira?",
  "¿Preferirías vivir en el mundo de Re:Zero o en el de Konosuba?",
  "¿Preferirías tener el retorno por muerte o el modo sabio de Naruto?",
  "¿Preferirías comer lo mismo todos los días o no volver a repetir un platillo?",
  "¿Preferirías ser rico y odiado o pobre y amado kashira?",
  "¿Preferirías perder la vista o el oído?",
  "¿Preferirías tener que cantar todo lo que dices o bailar cada vez que caminas?",
  "¿Preferirías vivir sin celular por un mes o sin salir de casa por una semana?",
  "¿Preferirías poder hablar con animales o con plantas?",
];

// Categorías de trivia. Comparación de respuestas usa normalizeText (sin acentos/mayúsculas).
const TRIVIA_QUESTIONS = {
  anime: [
    { q: "¿En qué anime aparece el personaje Beatrice, la bibliotecaria?", a: "re:zero" },
    { q: "¿Cómo se llama la habilidad de Subaru en Re:Zero que le permite regresar en el tiempo al morir?", a: "retorno por muerte" },
    { q: "¿Cuál es el apellido del protagonista de Naruto?", a: "uzumaki" },
    { q: "¿Qué fruta del diablo come Luffy en One Piece?", a: "gomu gomu" },
    { q: "¿Cómo se llama la espada maldita de Guts en Berserk?", a: "dragonslayer" },
    { q: "¿Cuál es el nombre real de Megumin en Konosuba?", a: "megumin" },
    { q: "¿En qué anime los titanes amenazan a la humanidad?", a: "attack on titan" },
    { q: "¿Cómo se llama la espada de Tanjiro en Demon Slayer?", a: "nichirin" },
  ],
  videojuegos: [
    { q: "¿En qué videojuego el protagonista es un plomero llamado Mario?", a: "mario" },
    { q: "¿Qué empresa desarrolla la saga The Legend of Zelda?", a: "nintendo" },
    { q: "¿Cómo se llama la ciudad ficticia de la saga Grand Theft Auto V?", a: "los santos" },
    { q: "¿Qué videojuego popularizó el concepto de 'battle royale' de forma masiva junto a PUBG?", a: "fortnite" },
    { q: "¿En qué juego el objetivo es plantar o desactivar una bomba entre terroristas y antiterroristas?", a: "counter strike" },
    { q: "¿Cómo se llama el erizo azul mascota de Sega?", a: "sonic" },
  ],
  historia: [
    { q: "¿En qué año cayó el Muro de Berlín?", a: "1989" },
    { q: "¿Qué imperio construyó el Coliseo de Roma?", a: "imperio romano" },
    { q: "¿En qué año terminó la Segunda Guerra Mundial?", a: "1945" },
    { q: "¿Qué civilización construyó Machu Picchu?", a: "inca" },
    { q: "¿Quién fue el primer emperador de Roma?", a: "augusto" },
  ],
  ciencia: [
    { q: "¿Cuál es el planeta más cercano al Sol?", a: "mercurio" },
    { q: "¿Cuál es el hueso más largo del cuerpo humano?", a: "femur" },
    { q: "¿Qué gas necesitan las plantas para hacer fotosíntesis?", a: "dioxido de carbono" },
    { q: "¿Cuál es el símbolo químico del oro?", a: "au" },
    { q: "¿Cuántos huesos tiene el cuerpo humano adulto?", a: "206" },
  ],
  geografia: [
    { q: "¿Cuál es el río más largo del mundo?", a: "amazonas" },
    { q: "¿Cuál es la capital de Japón?", a: "tokio" },
    { q: "¿Cuál es el país más poblado del mundo?", a: "india" },
    { q: "¿Cuál es el desierto más grande del mundo?", a: "sahara" },
    { q: "¿En qué continente está Egipto?", a: "africa" },
  ],
};

function generateMathQuestion() {
  const a = randInt(2, 50), b = randInt(2, 50), c = randInt(1, 20);
  const ops = ["+", "-", "*"];
  const op1 = pick(ops), op2 = pick(ops);
  const applyOp = (x, op, y) => op === "+" ? x + y : op === "-" ? x - y : x * y;
  const partial = applyOp(a, op1, b);
  const answer = applyOp(partial, op2, c);
  return { expr: `${a} ${op1} ${b} ${op2} ${c}`, answer };
}

// ─── Catálogo de la tienda ─────────────────────────────────────────────────
const SHOP_TITLES = [
  { id: "trabajador", name: "Trabajador", price: 150000 },
  { id: "empresario", name: "Empresario", price: 600000 },
  { id: "millonario", name: "Millonario", price: 2500000 },
];

const SHOP_ADVANTAGES = [
  { id: "ganancia", name: "Ganancia", price: 500000, desc: "Duplica el dinero que ganas en #w, #crime, #mine, #fish y #sell, para siempre." },
  { id: "cooldown", name: "Cooldown", price: 500000, desc: "Quita el 50% del cooldown de #w, #crime, #steal, #mine, #fish, #cf, #rt, #slots y #dice." },
  { id: "suerte", name: "Suerte", price: 500000, desc: "Duplica la probabilidad de encontrar un cofre en #mine y #fish (12% → 24%)." },
  { id: "durabilidad", name: "Durabilidad", price: 500000, desc: "Los picos y cañas que compres/craftees a partir de ahora duran el doble de usos." },
  { id: "inmortal", name: "Inmortal", price: 500000, desc: "Reduce a la mitad la probabilidad de morir en #mine (5% → 2.5%)." },
  { id: "botin", name: "Botín", price: 500000, desc: "Duplica la cantidad de materiales que consigues por cada #mine y #fish." },
  { id: "maestria", name: "Maestría", price: 500000, desc: "Reduce a la mitad la probabilidad de que falle el crafteo de Pico/Caña Pro y Dios (5% → 2.5%)." },
  { id: "grind", name: "Grind", price: 500000, desc: "Desbloquea #grind: ejecuta de un jalón TODAS tus actividades de economía que ya no tengan cooldown (#w, #crime, #dungeon, #ritual, #adventure, #slut). #mine/#fish no entran por ahora (su mecánica de picos/cañas es muy distinta)." },
];

// Mejoras de banco: cada tier reemplaza el tope anterior (no se suman). Se compran en orden
// con #shop banco / #buy [nombre], pagando desde el banco igual que el resto de la tienda.
const BANK_UPGRADES = [
  { id: "banco2", name: "Banco Nivel 2", price: 800000, cap: 25000000 },
  { id: "banco3", name: "Banco Nivel 3", price: 3000000, cap: 60000000 },
  { id: "banco4", name: "Banco Nivel 4", price: 8000000, cap: 150000000 },
];

const SHOP_ITEMS = [
  { id: "rezero_pereza", anime: "Re:Zero", name: "Autoridad de la pereza", price: 150000, profile: "Portador de la pereza" },
  { id: "rezero_espada", anime: "Re:Zero", name: "Espada Dragon Reid", price: 900000, profile: "Santo de la espada" },
  { id: "rezero_retorno", anime: "Re:Zero", name: "Retorno por muerte", price: 2500000, profile: "El desafortunado elegido por la envidia" },
  { id: "konosuba_baston", anime: "Konosuba", name: "Explosion Staff", price: 150000, profile: "Portador del bastón de Megumin" },
  { id: "konosuba_choker", anime: "Konosuba", name: "Choker de Darkness", price: 900000, profile: "Masoquista de élite" },
  { id: "konosuba_gracia", anime: "Konosuba", name: "Gracia de Eris", price: 2500000, profile: "Bendecido por la diosa ladrona" },
  { id: "eva_unidad01", anime: "Evangelion", name: "Unidad 01", price: 150000, profile: "Piloto de Eva" },
  { id: "eva_lanza", anime: "Evangelion", name: "Lanza de Longinus", price: 900000, profile: "Portador de la lanza sagrada" },
  { id: "eva_instr", anime: "Evangelion", name: "Instrumentalización", price: 2500000, profile: "El elegido del Tercer Impacto" },
  { id: "berserk_dragonslayer", anime: "Berserk", name: "Dragonslayer", price: 150000, profile: "Portador de la espada maldita" },
  { id: "berserk_armadura", anime: "Berserk", name: "Armadura del Berserker", price: 900000, profile: "Consumido por la bestia interior" },
  { id: "berserk_marca", anime: "Berserk", name: "Marca del Sacrificio", price: 2500000, profile: "Marcado por el destino" },
  { id: "jjk_maldicion", anime: "JJK", name: "Maldición Simple", price: 150000, profile: "Hechicero principiante" },
  { id: "jjk_dominio", anime: "JJK", name: "Dominio Expandido", price: 900000, profile: "Maestro de los dominios" },
  { id: "jjk_sukuna", anime: "JJK", name: "Sukuna Ryomen", price: 2500000, profile: "Vasija del Rey de las Maldiciones" },
  { id: "aot_espadas", anime: "Attack on Titan", name: "Espadas ODM", price: 150000, profile: "Soldado del Cuerpo de Exploración" },
  { id: "aot_colosal", anime: "Attack on Titan", name: "Titán Colosal", price: 900000, profile: "Portador del poder colosal" },
  { id: "aot_fundacional", anime: "Attack on Titan", name: "Titán Fundacional", price: 2500000, profile: "El que controla a todos los titanes" },
  { id: "ds_nichirin", anime: "Demon Slayer", name: "Nichirin Blade", price: 150000, profile: "Cazador de demonios" },
  { id: "ds_sol", anime: "Demon Slayer", name: "Respiración del Sol", price: 900000, profile: "Maestro de la respiración original" },
  { id: "ds_marca", anime: "Demon Slayer", name: "Marca del Cazador", price: 2500000, profile: "Marcado por los dioses" },
  { id: "op_gomu", anime: "One Piece", name: "Gum Gum Fruit", price: 150000, profile: "Usuario del poder del caucho" },
  { id: "op_haki", anime: "One Piece", name: "Haki de Rey", price: 900000, profile: "Portador del haki supremo" },
  { id: "op_nika", anime: "One Piece", name: "Fruta Nika", price: 2500000, profile: "El Guerrero de la Liberación" },
  { id: "nrt_sharingan", anime: "Naruto", name: "Sharingan", price: 150000, profile: "Portador del ojo copiador" },
  { id: "nrt_sabio", anime: "Naruto", name: "Modo Sabio", price: 900000, profile: "Maestro del chakra natural" },
  { id: "nrt_barion", anime: "Naruto", name: "Modo Barión", price: 2500000, profile: "El que consume su propia vida" },
  { id: "db_kamehame", anime: "Dragon Ball", name: "Kame Hame Ha", price: 150000, profile: "Discípulo de la Tortuga Hermit" },
  { id: "db_saiyan", anime: "Dragon Ball", name: "Super Saiyan", price: 900000, profile: "Guerrero legendario despertado" },
  { id: "db_instinto", anime: "Dragon Ball", name: "Ultra Instinto", price: 2500000, profile: "El que trasciende a los dioses" },
];

function findShopEntry(query) {
  const q = normalizeText(query);
  if (!q) return null;
  for (const t of SHOP_TITLES) if (normalizeText(t.name) === q) return { type: "title", ...t };
  for (const a of SHOP_ADVANTAGES) if (normalizeText(a.name) === q) return { type: "advantage", ...a };
  for (const b of BANK_UPGRADES) if (normalizeText(b.name) === q) return { type: "bank", ...b };
  for (const i of SHOP_ITEMS) if (normalizeText(i.name) === q) return { type: "item", ...i };
  // fallback: coincidencia parcial
  for (const t of SHOP_TITLES) if (normalizeText(t.name).includes(q)) return { type: "title", ...t };
  for (const a of SHOP_ADVANTAGES) if (normalizeText(a.name).includes(q)) return { type: "advantage", ...a };
  for (const b of BANK_UPGRADES) if (normalizeText(b.name).includes(q)) return { type: "bank", ...b };
  for (const i of SHOP_ITEMS) if (normalizeText(i.name).includes(q)) return { type: "item", ...i };
  return null;
}

// Busca una entrada de la tienda por su id interno (usado para la compra por número)
function findShopEntryById(id) {
  const t = SHOP_TITLES.find(x => x.id === id);
  if (t) return { type: "title", ...t };
  const a = SHOP_ADVANTAGES.find(x => x.id === id);
  if (a) return { type: "advantage", ...a };
  const b = BANK_UPGRADES.find(x => x.id === id);
  if (b) return { type: "bank", ...b };
  const i = SHOP_ITEMS.find(x => x.id === id);
  if (i) return { type: "item", ...i };
  return null;
}

function findAnimeItems(query) {
  const q = normalizeText(query);
  const animes = [...new Set(SHOP_ITEMS.map(i => i.anime))];
  const match = animes.find(a => normalizeText(a) === q) || animes.find(a => normalizeText(a).includes(q));
  if (!match) return null;
  return { anime: match, items: SHOP_ITEMS.filter(i => i.anime === match) };
}

// ─── Títulos especiales: rango global y personalizado ──────────────────────
const RANK_TITLES = {
  1: { id: "rank_1", name: "El rey de las coins #1" },
  2: { id: "rank_2", name: "Príncipe monetario (#2)" },
  3: { id: "rank_3", name: "El tercero" },
};

// Recalcula quién ocupa el top 1, 2 y 3 GLOBAL (suma de wallet+bank de TODOS los grupos de cada usuario)
// y otorga/retira el título especial correspondiente automáticamente. Los títulos son globales.
function updateGlobalRankTitles(db) {
  db.economy = db.economy || {};
  const totals = {};
  for (const groupEco of Object.values(db.economy)) {
    if (!groupEco || typeof groupEco !== "object") continue;
    for (const [num, eco] of Object.entries(groupEco)) {
      if (!eco || typeof eco !== "object") continue;
      totals[num] = (totals[num] || 0) + (eco.wallet || 0) + (eco.bank || 0);
    }
  }
  const top3 = Object.entries(totals)
    .map(([num, total]) => ({ num, total }))
    .filter(e => e.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 3);

  let changed = false;
  Object.values(RANK_TITLES).forEach((rt, idx) => {
    const ownerNum = top3[idx]?.num || null;
    for (const [num, inv] of Object.entries(db.inventory || {})) {
      if (!inv.titles) continue;
      const has = inv.titles.includes(rt.id);
      if (has && num !== ownerNum) {
        inv.titles = inv.titles.filter(t => t !== rt.id);
        if (inv.equippedTitle === rt.id) inv.equippedTitle = null;
        changed = true;
      }
    }
    if (ownerNum) {
      const oInv = getInv(db, ownerNum);
      if (!oInv.titles.includes(rt.id)) {
        oInv.titles.push(rt.id);
        changed = true;
      }
    }
  });
  if (changed) saveDB(db);
}

// Nombre legible de un título por su id, sea de tienda, de rango global o personalizado (todo global)
function titleName(db, id) {
  if (!id) return id;
  const shop = SHOP_TITLES.find(t => t.id === id);
  if (shop) return shop.name;
  const rank = Object.values(RANK_TITLES).find(t => t.id === id);
  if (rank) return rank.name;
  if (id.startsWith("custom_")) {
    const num = id.slice("custom_".length);
    return db.inventory?.[num]?.customTitleName || "Título personalizado";
  }
  return id;
}

function itemName(id) {
  return SHOP_ITEMS.find(i => i.id === id)?.name || id;
}

// Frase de perfil de un objeto (lo que se muestra en #profile, NUNCA el nombre explícito del objeto)
function itemProfilePhrase(id) {
  return SHOP_ITEMS.find(i => i.id === id)?.profile || id;
}

// Precio del título personalizado: 120,000¥ base + 12,000¥ por carácter
function customTitlePrice(text) {
  return 1200000 + text.length * 120000;
}

// Obtiene el nombre visible de un grupo (con caché en db.groupNames por si el bot ya no está en el grupo)
async function getGroupName(sock, db, groupId) {
  db.groupNames = db.groupNames || {};
  try {
    const meta = await sock.groupMetadata(groupId);
    if (meta?.subject) {
      db.groupNames[groupId] = meta.subject;
      return meta.subject;
    }
  } catch {}
  return db.groupNames[groupId] || "Grupo desconocido";
}

// Evita nombres duplicados: títulos de tienda, títulos de rango global, y otros custom ya usados (global)
function isBlockedTitleName(db, text, excludeNum) {
  const q = normalizeText(text);
  if (SHOP_TITLES.some(t => normalizeText(t.name) === q)) return true;
  if (Object.values(RANK_TITLES).some(t => normalizeText(t.name) === q)) return true;
  for (const [num, inv] of Object.entries(db.inventory || {})) {
    if (num === excludeNum) continue;
    if (inv.customTitleName && normalizeText(inv.customTitleName) === q) return true;
  }
  return false;
}

// Reutilizado por antiaudio/antisticker/antiimage/antivideo/antibot/antispam:
// borra el mensaje ofensor y registra una advertencia real, igual que hace #warn/antilink.
// Devuelve true si logró borrar+advertir, false si algo falló (no crítico, se ignora).
async function autoModDeleteAndWarn(sock, mDb, mFrom, mSenderPN, mNum, msgId, motivo) {
  try {
    await sock.sendMessage(mFrom, {
      delete: { remoteJid: mFrom, fromMe: false, id: msgId, participant: mSenderPN }
    });

    mDb.warns = mDb.warns || {};
    mDb.warns[mFrom] = mDb.warns[mFrom] || {};
    mDb.warns[mFrom][mSenderPN] = mDb.warns[mFrom][mSenderPN] || [];
    mDb.warns[mFrom][mSenderPN].push({
      motivo,
      fecha: new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" }),
      por: null,
      porNum: "Sistema (AutoMod)",
    });
    const totalWarns = mDb.warns[mFrom][mSenderPN].length;
    const warnLimit = getWarnLimit(mDb, mFrom);
    saveDB(mDb);

    await sock.sendMessage(mFrom, {
      text: `[ (¬_¬) ] @${mNum} tu mensaje fue borrado kashira.\n\n*Motivo:* ${motivo}\n*Advertencias:* ${totalWarns}/${warnLimit}`,
      mentions: [mSenderPN]
    });

    if (totalWarns >= warnLimit) {
      const list = mDb.warns[mFrom][mSenderPN]
        .map((w, i) => `${i + 1}. *${w.fecha}*\n   Motivo: ${w.motivo}\n   Por: ${w.por ? "@" + w.porNum : w.porNum}`)
        .join("\n\n");
      await sock.sendMessage(mFrom, {
        text: `[ (╬ Ò﹏Ó) ] @${mNum} llegó a *${totalWarns} advertencias* kashira!\n\n${list}`,
        mentions: [mSenderPN, ...mDb.warns[mFrom][mSenderPN].map(w => w.por).filter(Boolean)]
      });
      await applyWarnLimitAction(sock, mFrom, mSenderPN, mNum);
    }
    return true;
  } catch (e) {
    console.error("[AUTOMOD] Error al borrar/advertir:", e.message);
    return false;
  }
}

// Rastreo de #antispam: solo en memoria (no en DB), por grupo+número, mensajes recientes.
const spamTracker = {}; // { [`${groupId}:${num}`]: number[] (timestamps) }
const SPAM_WINDOW_MS = 10 * 1000;
const SPAM_MAX_MSGS = 5;

// Al llegar al límite de advertencias: si la persona es admin del grupo, NUNCA se le
// expulsa directo — solo se le intenta quitar el admin (si Beatrice tiene rango para
// hacerlo) y se avisa. Si NO es admin, se le expulsa directo.
async function applyWarnLimitAction(sock, groupJid, targetPN, targetNum) {
  const targetIsAdmin = await isAdmin(sock, groupJid, targetPN);
  if (targetIsAdmin) {
    const res = await safeGroupParticipantsUpdate(sock, groupJid, targetPN, "demote");
    if (res.ok) {
      await sock.sendMessage(groupJid, {
        text: `[ (╬ Ò﹏Ó) ] @${targetNum} es admin, así que solo se le quitó el admin kashira por llegar al límite de advertencias.`,
        mentions: [targetPN]
      });
    } else {
      await sock.sendMessage(groupJid, {
        text: `[ x_x ] @${targetNum} llegó al límite de advertencias y es admin, pero no pude quitarle el admin kashira (necesito ser admin del grupo, o tener más rango que él/ella).`,
        mentions: [targetPN]
      });
    }
    return;
  }
  const res = await safeGroupParticipantsUpdate(sock, groupJid, targetPN, "remove");
  if (res.ok) {
    await sock.sendMessage(groupJid, {
      text: `[ (╬ Ò﹏Ó) ] @${targetNum} fue expulsado kashira por llegar al límite de advertencias.`,
      mentions: [targetPN]
    });
  } else {
    await sock.sendMessage(groupJid, {
      text: `[ x_x ] @${targetNum} llegó al límite de advertencias, pero no pude expulsarlo kashira (necesito ser admin del grupo).`,
      mentions: [targetPN]
    });
  }
}

// db.warnLimits[groupId] = n — advertencias necesarias para el aviso de "llegó al límite"
// en ESE grupo, configurable por admins con #warnlimit. Default 5 si no se ha puesto nada.
function getWarnLimit(db, groupId) {
  const n = db.warnLimits?.[groupId];
  return (typeof n === "number" && n > 0) ? n : 5;
}

function getBeatriceWarnMsg(total, limit = 5) {
  if (total > limit) return "Se tarda ese #kick no? Kashira!";
  if (total === limit) return "Por mi que ya te saquen kashira! [X_X]";
  const remaining = limit - total;
  if (remaining === 1) return "Confié en ti, pero ya no tienes salvación, kashira... °﹏°";
  if (remaining === 2) return "Estoy decepcionada de ti, no es como si me importaras o algo parecido, kashira! >////<";
  if (remaining === 3) return "Mmmh, nada que decir kashira >-<";
  return "Vas por mal camino kashira, esfuérzate y yo misma haré que te quiten la warn ^w^";
}

async function handleCommand(sock, msg) {
  const db = loadDB();
  try {
    updateGlobalRankTitles(db);
  } catch (e) {
    console.error("[RANK TITLES] Error (no crítico, se ignora):", e.message);
  }

  updateLidMapFromMsg(msg);

  const from    = msg.key.remoteJid;
  const isGroup = from.endsWith("@g.us");
  const senderRaw = isGroup ? msg.key.participant || msg.key.remoteJid : msg.key.remoteJid;
  // Intentar obtener PN del senderPn field (Baileys 7+)
  const senderPn = msg.key.senderPn || msg.senderPn;
  let sender = senderPn
    ? (senderPn.includes("@") ? senderPn : senderPn + "@s.whatsapp.net")
    : resolveToPN(senderRaw);

  // Si seguimos con un @lid sin resolver (mapa aún no lo tenía), intentamos
  // rellenarlo al vuelo pidiendo los metadatos del grupo antes de rendirnos.
  if (isGroup && sender?.includes("@lid")) {
    const meta = await sock.groupMetadata(from).catch(() => null);
    if (meta) {
      updateLidMapFromMeta(meta);
      sender = resolveToPN(senderRaw);
    }
  }

  if (senderRaw?.includes("@lid") && sender !== senderRaw) storeLidPn(senderRaw, sender);
  const senderNum = sender.split("@")[0].split(":")[0];

  const type = getContentType(msg.message);
  let body =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    "";

  body = body.trim();

  if (!body.startsWith(CONFIG.prefix)) return;

  const rawCmd = body.slice(CONFIG.prefix.length).trim().split(/\s+/)[0].toLowerCase();
  
  if (isGroup && db.offGroups?.[from]) {
    if (rawCmd !== "on" && rawCmd !== "ongroup") return;
  }
  if (db.bannedUsers?.[senderNum]) return;

  const args = body.slice(CONFIG.prefix.length).trim().split(/\s+/);
  const rest = args.slice(1).join(" ");

  let finalCmd = "";
  const aliasMap = {
    "tt": "tt", "tiktok": "tt",
    "fb": "fb", "facebook": "fb",
    "yta": "yta", "ytaudio": "yta",
    "ytv": "ytv", "ytmp4": "ytv",
    "pin": "pin", "safebooru": "pin", "post": "pin",
    "toimg": "toimg", "seeimage": "toimg",
    "s": "s", "sticker": "s", "sgif": "s",
    "tag": "tag", "taghide": "tag",
    "prom": "prom", "promote": "prom",
    "dem": "dem", "demote": "dem",
    "gname": "gname", "gnombre": "gname",
    "desc": "desc", "setdesc": "desc",
    "wel": "wel", "welcome": "wel",
    "setwel": "setwel", "setwelcome": "setwel",
    "welimg": "welimg", "welcomeimg": "welimg",
    "twel": "twel", "testwel": "twel",
    "bye": "bye", "despedida": "bye",
    "setbye": "setbye", "setdespedida": "setbye",
    "byeimg": "byeimg", "despedidaimg": "byeimg",
    "tbye": "tbye", "testbye": "tbye",
    "pfp": "pfp", "setbotpfp": "pfp",
    "gpfp": "gpfp", "setgimg": "gpfp", "gimg": "gpfp", "groupimg": "gpfp",
    "bi": "bi", "botinfo": "bi",
    "on": "on", "ongroup": "on",
    "off": "off", "offgroup": "off",
    "toggles": "toggles", "interruptores": "toggles", "estado": "toggles",
    "globalon": "globalon", "globaloff": "globaloff",
    "gm": "gm", "nogm": "nogm", "invite": "invite",
    "k": "k", "kick": "k",
    "gi": "gi", "info": "gi",
    "p": "p", "ping": "p",
    "menu": "menu", "help": "menu",
    "b": "b", "ban": "b",
    "warn": "warn",
    "seew": "seew", "seewarns": "seew",
    "delwarn": "delwarn",
    "warnlimit": "warnlimit", "limitewarn": "warnlimit",
    "createprofile": "createprofile",
    "afk": "afk",
    "profile": "profile", "perfil": "profile",
    "stats": "stats", "estadisticas": "stats",
    "setname": "setname",
    "setgender": "setgender", "genero": "setgender",
    "profiledesc": "profiledesc", "setdesc2": "profiledesc",
    "favorite": "favorite", "favorito": "favorite", "fav": "favorite",
    "profilepfp": "profilepfp",
    "setbirth": "setbirth", "nacimiento": "setbirth",
    "setprofile": "setprofile",
    "marry": "marry", "casar": "marry",
    "forcemarry": "forcemarry",
    "couples": "couples", "parejas": "couples",
    "divorce": "divorce", "divorcio": "divorce",
    "adoptpet": "adoptpet", "adoptarpet": "adoptpet", "adoptarmascota": "adoptpet",
    "allp": "allp", "allg": "allg",
    "secret": "secret",
    "lastseen": "lastseen", "dumpstats": "dumpstats",
    "jinx": "jinx", "echo": "echo", "curseword": "curseword", "mirror": "mirror",
    "ghostkick": "ghostkick", "silentwarn": "silentwarn",
    "alertme": "alertme",
    "shadowlog": "shadowlog", "readlog": "readlog",
    "groupspy": "groupspy",
    "setluck": "setluck",
    "pet": "pet", "mascota": "pet",
    "releasepet": "releasepet", "soltarpet": "releasepet", "darenadopcion": "releasepet",
    "renamepet": "renamepet", "renombrarpet": "renamepet",
    "feedpet": "feedpet", "alimentarpet": "feedpet", "alimentarmascota": "feedpet",
    "playpet": "playpet", "jugarpet": "playpet", "jugarmascota": "playpet",
    "preg": "preg", "pregnant": "preg", "embarazo": "preg", "tenerhijo": "preg",
    "renamekid": "renamekid", "renombrarhijo": "renamekid",
    "pvsp": "pvsp", "petvspet": "pvsp", "retarpet": "pvsp",
    "acceptvs": "acceptvs", "aceptarvs": "acceptvs",
    "level": "level", "nivel": "level", "lvl": "level",
    "del": "del", "delete": "del",
    "calc": "calc", "calcular": "calc",
    "tr": "tr", "trad": "tr", "traducir": "tr", "translate": "tr",
    "ship": "ship",
    "vs": "vs",
    "best": "best", "mejor": "best",
    "rat": "rat", "rata": "rat",
    "simp": "simp",
    "iq": "iq",
    "gay": "gay",
    "lesbian": "lesbian", "lesbiana": "lesbian",
    "bisexual": "bisexual",
    "freaky": "freaky",
    "otaku": "otaku",
    "funny": "funny", "gracioso": "funny",
    "qr": "qr", "qrcode": "qr",
    "w": "work", "work": "work",
    "crime": "crime",
    "grind": "grind",
    "dungeon": "dungeon", "mazmorra": "dungeon",
    "ritual": "ritual",
    "adventure": "adventure", "aventura": "adventure",
    "slut": "slut",
    "d": "deposit", "deposit": "deposit", "depositar": "deposit",
    "with": "withdraw", "retirar": "withdraw", "withdraw": "withdraw",
    "steal": "steal", "robar": "steal",
    "bal": "bal", "balance": "bal", "saldo": "bal",
    "einfo": "einfo", "cooldowns": "einfo", "cds": "einfo",
    "cf": "cf", "coinflip": "cf",
    "rt": "rt", "roullette": "rt", "roulette": "rt", "ruleta": "rt",
    "slots": "slots", "tragamonedas": "slots", "tragaperras": "slots",
    "dice": "dice", "dados": "dice",
    "pay": "pay", "pagar": "pay",
    "nick": "nick", "apodo": "nick",
    "nicks": "nicks", "apodos": "nicks", "misapodos": "nicks",
    "top": "top",
    "shop": "shop", "tienda": "shop",
    "buy": "buy", "comprar": "buy",
    "equip": "equip", "equipar": "equip",
    "unequip": "unequip", "desequipar": "unequip",
    "inv": "inv", "inventario": "inv",
    "perks": "perks", "ventajas": "perks", "advantages": "perks",
    "customtitle": "customtitle", "titulopersonalizado": "customtitle", "settitle": "customtitle",
    "give": "give",
    "delprofile": "delprofile", "delperfil": "delprofile",
    "reset": "reset",
    "promowner": "promowner", "addowner": "promowner",
    "demowner": "demowner", "deleteowner": "demowner", "removeowner": "demowner",
    "enable": "on", "disable": "off",
    "daily": "daily", "diario": "daily",
    "mine": "mine", "minar": "mine",
    "fish": "fish", "pescar": "fish",
    "sell": "sell", "vender": "sell",
    "craft": "craft", "craftear": "craft",
    "keys": "keys", "llaves": "keys",
    "mats": "mats", "materiales": "mats",
    "tools": "tools", "herramientas": "tools",
    "zones": "zones", "zonas": "zones",
    "lock": "lock", "bloquear": "lock",
    "timer": "timer", "temporizador": "timer", "recordatorio": "timer",
    "birthday": "birthday", "cumple": "birthday", "cumpleanos": "birthday",
    "setbirthday": "setbirthday", "setcumple": "setbirthday",
    "birthdayimg": "birthdayimg", "cumpleimg": "birthdayimg",
    "tbirthday": "tbirthday", "testbirthday": "tbirthday", "tcumple": "tbirthday",
    "poll": "poll", "encuesta": "poll",
    "define": "define", "definir": "define", "diccionario": "define",
    "short": "short", "acortar": "short", "shorturl": "short", "shorten": "short",
    "encrypt": "encrypt", "encriptar": "encrypt", "cifrar": "encrypt",
    "decrypt": "decrypt", "desencriptar": "decrypt", "descifrar": "decrypt",
    "tomp3": "tomp3", "toaudio": "tomp3", "toaudi": "tomp3",
    "comp": "comp", "comprimir": "comp", "compress": "comp",
    "blur": "blur", "desenfocar": "blur", "desenfoque": "blur",
    "sharpen": "sharpen", "nitidez": "sharpen", "enfocar": "sharpen",
    "invert": "invert", "invertir": "invert", "invertcolor": "invert",
    "reverse": "reverse", "invertirvideo": "reverse", "revertir": "reverse",
    "clrcache": "clrcache", "limpiarcache": "clrcache", "clearcache": "clrcache",
    "bug": "bug", "reportbug": "bug", "reportarbug": "bug",
    "suggest": "suggest", "darsugerencia": "suggest", "sugerencia": "suggest", "sugerir": "suggest",
    "bugs": "bugs", "reportes": "bugs",
    "delbug": "delbug", "borrarbug": "delbug", "eliminarbug": "delbug",
    "delbugs": "delbugs", "borrarbugs": "delbugs", "clearbugs": "delbugs",
    "8ball": "eightball", "eightball": "eightball", "bola8": "eightball",
    "owoify": "owoify", "owo": "owoify",
    "trivia": "trivia",
    "math": "math", "matematicas": "math",
    "wouldyourather": "wouldyourather", "wyr": "wouldyourather", "preferirias": "wouldyourather",
    "lyrics": "lyrics", "letra": "lyrics",
    "hidetagimg": "tag", "hidetagvid": "tag", "hidetag": "tag",
    "admins": "admins",
    "invitelink": "invitelink", "linkgrupo": "invitelink",
    "revoke": "revoke",
    "setrules": "setrules", "setreglas": "setrules",
    "rules": "rules", "reglas": "rules",
    "clearwarns": "clearwarns", "borraradvertencias": "clearwarns",
    "restart": "restart", "reiniciar": "restart",
  };

  // Registra automáticamente #hug, #kiss, #slap, etc. (una entrada por acción,
  // el comando es igual a su propio nombre, sin alias extra).
  for (const key of Object.keys(ANIME_ACTIONS)) aliasMap[key] = key;

  if (aliasMap[rawCmd]) {
    finalCmd = aliasMap[rawCmd];
  } else {
    finalCmd = "invalid_command_error"; // <--- CAMBIA EL 'return;' POR ESTO
  }

  const contextInfo = getMsgContextInfo(msg);
  // unwrapMessage() desenreda ephemeralMessage / viewOnceMessage / viewOnceMessageV2,
  // así comandos como #s, #toimg, #comp, etc. funcionan igual si citas una imagen/video/sticker
  // mandado como "ver una vez" (antes se quedaban sin detectar nada en ese caso).
  const quotedContext = unwrapMessage(contextInfo?.quotedMessage);
  // Lo mismo, pero para cuando el medio viene adjuntado directo al mensaje (no citado).
  const msgContent = unwrapMessage(msg.message);

  // ══════════════════════════════
  //    BLOQUEO: ECONOMÍA REQUIERE PERFIL
  // ══════════════════════════════
  // Todo lo que gana, gasta o gestiona dinero/inventario necesita perfil primero,
  // así evitamos fantasmas en la economía y datos huérfanos sin nombre/perfil.
  const ECONOMY_COMMANDS = new Set([
    "work", "crime", "daily", "deposit", "withdraw", "steal",
    "bal", "cf", "rt", "pay",
    "buy", "equip", "unequip", "inv", "perks", "customtitle",
    "mine", "fish", "sell", "craft",
  ]);
  if (ECONOMY_COMMANDS.has(finalCmd) && !db.profiles?.[senderNum]) {
    const errorMp4Path = './gifs/error.mp4';
    const noProfileCaption = `*⌞ ERROR (⁠・⁠o⁠・⁠) ⌝*\n\n(=⁠_⁠=) No puedes usar *#${rawCmd}* sin perfil kashira. Primero crea uno con *#createprofile*.`;
    if (fs.existsSync(errorMp4Path)) {
      await sock.sendMessage(from, {
        video: fs.readFileSync(errorMp4Path),
        mimetype: 'video/mp4',
        gifPlayback: true,
        caption: noProfileCaption
      }, { quoted: msg });
    } else {
      await sendText(sock, from, noProfileCaption, msg);
    }
    return;
  }

  // ══════════════════════════════
  //    BLOQUEO: CATEGORÍA DESACTIVADA EN ESTE GRUPO
  // ══════════════════════════════
  if (isGroup && CATEGORY_MAP[finalCmd] && db.disabledCategories?.[from]?.includes(CATEGORY_MAP[finalCmd])) {
    const errorMp4Path = './gifs/error.mp4';
    const disabledCaption = `*⌞ ERROR (⁠・⁠o⁠・⁠) ⌝*\n\n(=⁠_⁠=) El comando *#${rawCmd}* está desactivado en este grupo (categoría: *${CATEGORY_MAP[finalCmd]}*). Un admin puede reactivarlo con #on ${CATEGORY_MAP[finalCmd]}.`;
    if (fs.existsSync(errorMp4Path)) {
      await sock.sendMessage(from, {
        video: fs.readFileSync(errorMp4Path),
        mimetype: 'video/mp4',
        gifPlayback: true,
        caption: disabledCaption
      }, { quoted: msg });
    } else {
      await sendText(sock, from, disabledCaption, msg);
    }
    return;
  }

  // ══════════════════════════════
  //    BLOQUEO: COMANDO INDIVIDUAL BLOQUEADO (#lock)
  // ══════════════════════════════
  if (isGroup && finalCmd !== "lock" && db.lockedCommands?.[from]?.includes(finalCmd)) {
    const senderIsAdminForLock = await isAdmin(sock, from, sender).catch(() => false);
    if (!senderIsAdminForLock && !isOwnerLevel(db, sender)) {
      const errorMp4Path = './gifs/error.mp4';
      const lockedCaption = `*⌞ ERROR (⁠・⁠o⁠・⁠) ⌝*\n\n(⁠๑⁠•⁠﹏⁠•⁠) El comando *#${rawCmd}* está bloqueado en este grupo kashira. Un admin puede desbloquearlo con #lock ${rawCmd}.`;
      if (fs.existsSync(errorMp4Path)) {
        await sock.sendMessage(from, {
          video: fs.readFileSync(errorMp4Path),
          mimetype: 'video/mp4',
          gifPlayback: true,
          caption: lockedCaption
        }, { quoted: msg });
      } else {
        await sendText(sock, from, lockedCaption, msg);
      }
      return;
    }
  }

  // ══════════════════════════════
  //    BLOQUEO: ONLYADMINS (solo administradores pueden usar comandos del bot)
  // ══════════════════════════════
  // Exentos: #menu/#bi (para que cualquiera pueda ver info del bot) y #on/#off/#toggles
  // (para que un admin real siempre pueda revisar/apagar esto aunque se quedó mal configurado).
  const ONLYADMINS_EXEMPT_CMDS = new Set(["menu", "bi", "on", "off", "toggles"]);
  if (isGroup && db.onlyAdmins?.[from] && !ONLYADMINS_EXEMPT_CMDS.has(finalCmd)) {
    const senderIsAdminForGate = await isAdmin(sock, from, sender).catch(() => false);
    if (!senderIsAdminForGate && !isOwnerLevel(db, sender)) {
      const errorMp4Path = './gifs/error.mp4';
      const onlyAdminsCaption = `*⌞ ERROR (⁠・⁠o⁠・⁠) ⌝*\n\n(=⁠_⁠=) Solo los administradores pueden usar comandos del bot en este grupo ahora mismo kashira.`;
      if (fs.existsSync(errorMp4Path)) {
        await sock.sendMessage(from, {
          video: fs.readFileSync(errorMp4Path),
          mimetype: 'video/mp4',
          gifPlayback: true,
          caption: onlyAdminsCaption
        }, { quoted: msg });
      } else {
        await sendText(sock, from, onlyAdminsCaption, msg);
      }
      return;
    }
  }

  // ══════════════════════════════
  //    DESCARGAS
  // ══════════════════════════════
  if (finalCmd === "tt") {
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #tt [url] kashira.", msg);
    const outPath = uniqueTmpPath("tiktok", ".mp4");
    sendText(sock, from, "[ (p^.^q) ] ¡Procesando enlace de TikTok! Espera un momento kashira...", msg);

    execFile("yt-dlp", [
      "-f", "mp4[filesize<50M]/best[filesize<50M]/mp4/best",
      "--max-filesize", "50m",
      "-o", outPath, rest
    ], async (err) => {
      if (err) {
        if (err.message.includes("File is larger") || err.message.includes("filesize")) {
          return sendText(sock, from, "[ ;﹏; ] El video es demasiado pesado para enviarse por WhatsApp kashira (límite 50MB).", msg);
        }
        return sendText(sock, from, "[ ;﹏; ] Error: " + err.message, msg);
      }
      try {
        const buffer = fs.readFileSync(outPath);
        await sock.sendMessage(from, { video: buffer, mimetype: "video/mp4", caption: "(*~▽~)☆ TikTok completado" }, { quoted: msg });
      } catch (e) {
        await sendText(sock, from, "[ ;﹏; ] Error de transmisión: " + e.message, msg);
      } finally {
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      }
    });
  }

  else if (finalCmd === "fb") {
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #fb [url]", msg);
    const outPath = uniqueTmpPath("facebook", ".mp4");
    sendText(sock, from, "[ (p^.^q) ] ¡Procesando enlace de Facebook! Espera un momento kashira...", msg);

    execFile("yt-dlp", ["-f", "mp4[filesize<50M]/best[filesize<50M]", "--merge-output-format", "mp4", "--max-filesize", "50m", "-o", outPath, rest], async (err) => {
      if (err) {
        if (err.message.includes("File is larger") || err.message.includes("filesize")) {
          return sendText(sock, from, "[ ;﹏; ] El video es demasiado pesado kashira (límite 50MB).", msg);
        }
        return sendText(sock, from, "[ ;﹏; ] Error: " + err.message, msg);
      }
      try {
        const buffer = fs.readFileSync(outPath);
        await sock.sendMessage(from, { video: buffer, mimetype: "video/mp4", caption: "(*~▽~)☆ Facebook completado" }, { quoted: msg });
      } catch (e) {
        await sendText(sock, from, "[ ;﹏; ] Error de transmisión: " + e.message, msg);
      } finally {
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      }
    });
  }

  else if (finalCmd === "yta") {
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #yta [nombre o url]", msg);

    execFile("yt-dlp", ["--print", "title", "--print", "duration_string", "--print", "thumbnail", "--print", "id", "--default-search", "ytsearch", rest], async (metaErr, stdout) => {
      let coverUrl = null;
      let metaText = `[ (p^.^q) ] Descargando audio en background kashira...`;

      if (!metaErr && stdout) {
        const lines = stdout.split("\n");
        const title = lines[0] || "Desconocido";
        const duration = lines[1] || "—";
        coverUrl = lines[2]?.trim();
        const videoId = lines[3]?.trim();
        if (!coverUrl?.startsWith("http")) coverUrl = videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : null;
        metaText = `*⌞ YouTube Audio ⌝*\n\n(o^-')b *Título:* ${title}\n\n(p^.^q) *Duración:* ${duration}\n\n(*^.^*) ¡Descargando audio kashira!`;
      }

      if (coverUrl) {
        try {
          await sock.sendMessage(from, { image: { url: coverUrl }, caption: metaText }, { quoted: msg });
        } catch (e) {
          console.error("[YTA] No se pudo mandar la miniatura:", e.message);
          await sendText(sock, from, metaText, msg);
        }
      } else {
        await sendText(sock, from, metaText, msg);
      }

      const outPath = uniqueTmpPath("audio", ".mp3");
      execFile("yt-dlp", ["-x", "--audio-format", "mp3", "--audio-quality", "0", "--max-filesize", "50m", "--default-search", "ytsearch", "-o", outPath, rest], { maxBuffer: 1024 * 1024 * 20 }, async (err, stdout, stderr) => {
        if (err) {
          if (err.message.includes("File is larger") || err.message.includes("filesize")) {
            return sendText(sock, from, "[ ;﹏; ] El audio es demasiado pesado kashira (límite 50MB).", msg);
          }
          console.error("[YTA] yt-dlp falló:", err.message, stderr || "");
          return sendText(sock, from, "[ ;﹏; ] No pude descargar el audio kashira, puede que el link/búsqueda no sea válida.", msg);
        }
        if (!fs.existsSync(outPath)) {
          console.error("[YTA] yt-dlp terminó sin errores pero el archivo de salida no existe:", outPath, stderr || "");
          return sendText(sock, from, "[ ;﹏; ] El audio no se pudo generar kashira (yt-dlp no produjo el archivo final). Intenta de nuevo o con otro video.", msg);
        }
        try {
          const buffer = fs.readFileSync(outPath);
          await sock.sendMessage(from, { audio: buffer, mimetype: "audio/mpeg", ptt: false }, { quoted: msg });
        } catch (e) {
          await sendText(sock, from, "[ ;﹏; ] Error al enviar audio: " + e.message, msg);
        } finally {
          if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
        }
      });
    });
  }

  else if (finalCmd === "ytv") {
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #ytv [nombre o url]", msg);

    execFile("yt-dlp", ["--print", "title", "--print", "duration_string", "--print", "thumbnail", "--print", "id", "--default-search", "ytsearch", rest], async (metaErr, stdout) => {
      let coverUrl = null;
      let metaText = `[ (p^.^q) ] Descargando video en background...`;

      if (!metaErr && stdout) {
        const lines = stdout.split("\n");
        const title = lines[0] || "Desconocido";
        const duration = lines[1] || "—";
        coverUrl = lines[2]?.trim();
        const videoId = lines[3]?.trim();
        if (!coverUrl?.startsWith("http")) coverUrl = videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : null;
        metaText = `*⌞ YouTube Video ⌝*\n\n(o^-')b *Título:* ${title}\n(p^.^q) *Duración:* ${duration}\n\n(*^.^*) ¡Descargando video kashira!`;
      }

      if (coverUrl) {
        try {
          await sock.sendMessage(from, { image: { url: coverUrl }, caption: metaText }, { quoted: msg });
        } catch (e) {
          console.error("[YTV] No se pudo mandar la miniatura:", e.message);
          await sendText(sock, from, metaText, msg);
        }
      } else {
        await sendText(sock, from, metaText, msg);
      }

      const outPath = uniqueTmpPath("video", ".mp4");
      execFile("yt-dlp", ["-f", "mp4[filesize<50M]/best[filesize<50M]/mp4", "--max-filesize", "50m", "--merge-output-format", "mp4", "--default-search", "ytsearch", "-o", outPath, rest], { maxBuffer: 1024 * 1024 * 20 }, async (err, stdout, stderr) => {
        if (err) {
          if (err.message.includes("File is larger") || err.message.includes("filesize")) {
            return sendText(sock, from, "[ ;﹏; ] El video es demasiado pesado kashira (límite 50MB).", msg);
          }
          // Se registra el stderr de yt-dlp completo en consola para poder diagnosticar
          // (el mensaje que ve el usuario se queda corto para no exponer rutas/detalles internos).
          console.error("[YTV] yt-dlp falló:", err.message, stderr || "");
          return sendText(sock, from, "[ ;﹏; ] No pude descargar el video kashira, puede que el link/búsqueda no sea válida.", msg);
        }
        // yt-dlp a veces reporta éxito (exit code 0) pero no deja el archivo en la ruta
        // esperada (por ejemplo si necesitaba fusionar audio+video con ffmpeg y ese paso
        // falló silenciosamente). Se verifica antes de leer para no tirar un ENOENT crudo.
        if (!fs.existsSync(outPath)) {
          console.error("[YTV] yt-dlp terminó sin errores pero el archivo de salida no existe:", outPath, stderr || "");
          return sendText(sock, from, "[ ;﹏; ] El video no se pudo generar kashira (yt-dlp no produjo el archivo final). Intenta de nuevo o con otro video.", msg);
        }
        try {
          const buffer = fs.readFileSync(outPath);
          await sock.sendMessage(from, { video: buffer, mimetype: "video/mp4" }, { quoted: msg });
        } catch (e) {
          await sendText(sock, from, "[ ;﹏; ] Error de envío: " + e.message, msg);
        } finally {
          if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
        }
      });
    });
  }

  else if (finalCmd === "pin") {
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #pin [etiquetas de búsqueda]", msg);
    sendText(sock, from, "[ (p^.^q) ] Buscando arte seguro en Safebooru kashira...", msg);

    const searchTags = rest.trim().replace(/\s+/g, "+");
    const url = `https://safebooru.org/index.php?page=dapi&s=post&q=index&json=1&limit=50&tags=${searchTags}`;

    try {
      const response = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" }
      });

      if (!response.data || response.data.length === 0) {
        return sendText(sock, from, "[ ;﹏; ] No encontré resultados para esa búsqueda kashira.", msg);
      }

      const randomPost = response.data[Math.floor(Math.random() * response.data.length)];
      const imgUrl = randomPost.image.startsWith("http") ? randomPost.image : `https://safebooru.org/images/${randomPost.directory}/${randomPost.image}`;

      const imgResponse = await axios.get(imgUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(imgResponse.data, 'binary');

      await sock.sendMessage(from, { 
        image: buffer, 
        caption: `*⌞ Safebooru Result ⌝*\n\n(o^-')b *ID:* ${randomPost.id}\n(p^.^q) *Tags:* ${rest}`
      }, { quoted: msg });

    } catch (e) {
      await sendText(sock, from, "[ x_x ] Error al conectar con Safebooru: " + e.message, msg);
    }
  }

  else if (finalCmd === "lyrics") {
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #lyrics [nombre de la canción]", msg);
    sendText(sock, from, "[ (p^.^q) ] Buscando la letra kashira...", msg);

    try {
      const searchRes = await axios.get("https://itunes.apple.com/search", {
        params: { term: rest, entity: "song", limit: 5 },
      });
      const results = (searchRes.data?.results || []).filter(r => r.trackName && r.artistName);

      if (!results.length) {
        return sendText(sock, from, "[ ;﹏; ] No encontré ninguna canción con ese nombre kashira.", msg);
      }

      if (results.length === 1) {
        return await sendLyricsResult(sock, from, msg, results[0].artistName, results[0].trackName);
      }

      // Varias coincidencias: mostramos opciones y esperamos a que quien buscó responda con un número.
      if (pendingLyrics[from]) clearLyricsPending(from);
      const options = results.map(r => ({ artist: r.artistName, title: r.trackName }));
      const list = options.map((o, i) => `${i + 1}. ${o.title} — ${o.artist}`).join("\n");

      const timeout = setTimeout(() => clearLyricsPending(from), LYRICS_SELECT_TIMEOUT_MS);
      pendingLyrics[from] = { requester: sender, options, timeout };

      await sendText(sock, from, `*⌞ Varias Coincidencias ⌝*\n\n(o^.^o) Encontré varias canciones kashira, responde con el número de la que quieres:\n\n${list}\n\n_Tienes 45 segundos._`, msg);
    } catch (e) {
      await sendText(sock, from, "[ x_x ] Error al buscar la canción: " + e.message, msg);
    }
  }

  // ══════════════════════════════
  //    UTILIDADES
  // ══════════════════════════════

  else if (finalCmd === "s") {
    const imgMsg = msgContent?.imageMessage || quotedContext?.imageMessage;
    const vidMsg = msgContent?.videoMessage || quotedContext?.videoMessage;
    const stMsg = msgContent?.stickerMessage || quotedContext?.stickerMessage;

    if (!imgMsg && !vidMsg && !stMsg) {
      return sendText(sock, from, "Este comando requiere una imagen/gif/sticker citado o adjuntado kashira!.", msg);
    }

    const stickerDesc = rest.trim();
    const authorName = db.profiles?.[senderNum]?.name || msg.pushName || senderNum;
    const groupName = isGroup ? await getGroupName(sock, db, from) : null;

    // Si ya es un sticker hecho, no hace falta reconvertirlo con ffmpeg: solo se
    // le reescribe el EXIF (nombre/autor) y se reenvía. Así #s también sirve
    // para renombrar stickers que ya existen.
    if (stMsg) {
      try {
        const rawBuffer = await downloadMedia(stMsg, "sticker");
        const stkBuffer = await writeStickerExif(rawBuffer, stickerDesc, authorName, groupName);
        await sock.sendMessage(from, { sticker: stkBuffer }, { quoted: msg });
      } catch (e) {
        await sendText(sock, from, "[ ;﹏; ] Error al renombrar el sticker: " + e.message, msg);
      }
      return;
    }

    const tmpIn = uniqueTmpPath("input");
    const tmpPng = uniqueTmpPath("temp", ".png");
    const tmpOut = uniqueTmpPath("stk_out", ".webp");

    try {
      if (imgMsg) {
        const buffer = await downloadMedia(imgMsg, "image");
        fs.writeFileSync(tmpIn, buffer);

        ffmpeg(tmpIn)
          .output(tmpPng)
          .on("end", () => {
            ffmpeg(tmpPng)
              .outputOptions([
                "-vcodec libwebp",
                "-vf scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:(512-iw)/2:(512-ih)/2:color=white@0"
              ])
              .output(tmpOut)
              .on("end", async () => {
                const rawBuffer = fs.readFileSync(tmpOut);
                const stkBuffer = await writeStickerExif(rawBuffer, stickerDesc, authorName, groupName);
                await sock.sendMessage(from, { sticker: stkBuffer }, { quoted: msg });
                [tmpIn, tmpPng, tmpOut].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
              })
              .on("error", async (err) => {
                await sendText(sock, from, "[ ;﹏; ] Error de renderizado: " + err.message, msg);
                [tmpIn, tmpPng, tmpOut].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
              })
              .run();
          })
          .on("error", async (err) => {
            await sendText(sock, from, "[ ;﹏; ] Error al convertir a PNG: " + err.message, msg);
            [tmpIn, tmpPng].forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });
          })
          .run();

      } else {
        const buffer = await downloadMedia(vidMsg, "video");
        fs.writeFileSync(tmpIn, buffer);
        ffmpeg(tmpIn)
          .outputOptions([
            "-vcodec libwebp",
            "-lossless 1",
            "-loop 0",
            "-an",
            "-vsync 0",
            "-vf scale=240:240:force_original_aspect_ratio=decrease,fps=12,pad=240:240:(240-iw)/2:(240-ih)/2:color=white@0"
          ])
          .output(tmpOut)
          .on("end", async () => {
            const rawBuffer = fs.readFileSync(tmpOut);
            const stkBuffer = await writeStickerExif(rawBuffer, stickerDesc, authorName, groupName);
            await sock.sendMessage(from, { sticker: stkBuffer }, { quoted: msg });
            if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
            if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
          })
          .on("error", async (err) => {
            await sendText(sock, from, "[ ;﹏; ] Error al procesar video: " + err.message, msg);
            if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
            if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
          })
          .run();
      }
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] Error general: " + e.message, msg);
    }
  }


  else if (finalCmd === "calc") {
    const parts = rest.trim().split(/\s+/);
    const op = (parts[0] || "").toLowerCase();
    const a = parseFloat(parts[1]);
    const b = parseFloat(parts[2]);

    const ops = {
      sumar:       { fn: (a, b) => a + b, label: "Suma" },
      restar:      { fn: (a, b) => a - b, label: "Resta" },
      multiplicar: { fn: (a, b) => a * b, label: "Multiplicación" },
      dividir:     { fn: (a, b) => b !== 0 ? a / b : null, label: "División" },
      porcentaje:  { fn: (a, b) => (a / 100) * b, label: "Porcentaje" },
      exponente:   { fn: (a, b) => Math.pow(a, b), label: "Exponente" },
      raiz:        { fn: (a) => Math.sqrt(a), label: "Raíz cuadrada" },
    };

    if (!ops[op]) {
      return sendText(sock, from,
        "[ x_x ] Operaciones disponibles:\n\n" +
        "#calc sumar [a] [b]\n" +
        "#calc restar [a] [b]\n" +
        "#calc multiplicar [a] [b]\n" +
        "#calc dividir [a] [b]\n" +
        "#calc porcentaje [a] [b]   → a% de b\n" +
        "#calc exponente [a] [b]   → a elevado a b\n" +
        "#calc raiz [a]",
        msg
      );
    }

    if (op === "raiz") {
      if (isNaN(a) || a < 0) return sendText(sock, from, "[ x_x ] Usa: #calc raiz [número positivo]", msg);
      return sendText(sock, from, `*⌞ ${ops[op].label} ⌝*\n\n√${a} = *${ops[op].fn(a)}*`, msg);
    }

    if (isNaN(a) || isNaN(b)) return sendText(sock, from, `[ x_x ] Usa: #calc ${op} [a] [b]`, msg);

    const result = ops[op].fn(a, b);
    if (result === null) return sendText(sock, from, "[ x_x ] No se puede dividir entre cero kashira.", msg);

    const resultStr = Number.isInteger(result) ? result : result.toFixed(4).replace(/\.?0+$/, "");
    await sendText(sock, from, `*⌞ ${ops[op].label} ⌝*\n\n${a} ${op === "porcentaje" ? "% de" : op === "exponente" ? "^" : ""} ${b} = *${resultStr}*`, msg);
  }

  else if (finalCmd === "tr") {
    const quotedText =
      quotedContext?.conversation ||
      quotedContext?.extendedTextMessage?.text ||
      quotedContext?.imageMessage?.caption ||
      quotedContext?.videoMessage?.caption ||
      "";

    if (!quotedText) return sendText(sock, from, "[ x_x ] Responde a un mensaje de texto con #tr [idioma]\n\nEjemplo: #tr ingles\n\nIdiomas: español, ingles, frances, aleman, italiano, portugues, japones, coreano, chino, ruso", msg);

    const langArg = (rest || "").trim().toLowerCase();
    const langMap = {
      "español": "es", "espanol": "es", "es": "es",
      "ingles": "en", "inglés": "en", "en": "en",
      "frances": "fr", "francés": "fr", "fr": "fr",
      "aleman": "de", "alemán": "de", "de": "de",
      "italiano": "it", "it": "it",
      "portugues": "pt", "portugués": "pt", "pt": "pt",
      "japones": "ja", "japonés": "ja", "ja": "ja",
      "coreano": "ko", "ko": "ko",
      "chino": "zh", "zh": "zh",
      "ruso": "ru", "ru": "ru",
    };

    const targetLang = langMap[langArg];
    if (!targetLang) return sendText(sock, from, "[ x_x ] Idioma no reconocido. Usa: español, ingles, frances, aleman, italiano, portugues, japones, coreano, chino, ruso", msg);

    try {
      const detectRes = await axios.get("https://api.mymemory.translated.net/get", {
        params: { q: quotedText, langpair: `autodetect|${targetLang}` }
      });

      const translated = detectRes.data?.responseData?.translatedText;

      if (!translated) return sendText(sock, from, "[ ;﹏; ] No se pudo traducir el mensaje kashira.", msg);

      await sendText(sock, from,
        `*⌞ Traducción ⌝*\n\n` +
        `(o^-')b *Original:*\n${quotedText}\n\n` +
        `(p^.^q) *Traducido (${langArg}):*\n${translated}`,
        msg
      );
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] Error de traducción: " + e.message, msg);
    }
  }

  else if (finalCmd === "qr") {
    const imgMsg = msg.message?.imageMessage || quotedContext?.imageMessage;

    if (imgMsg) {
      // Modo lectura: decodificar QR de una imagen
      try {
        const buffer = await downloadMedia(imgMsg, "image");
        const FormData = require("form-data");
        const fdata = new FormData();
        fdata.append("file", buffer, { filename: "qr.jpg" });

        const result = await axios.post("https://api.qrserver.com/v1/read-qr-code/", fdata, {
          headers: fdata.getHeaders(),
        });

        const decoded = result.data?.[0]?.symbol?.[0]?.data;
        const errorMsg = result.data?.[0]?.symbol?.[0]?.error;

        if (!decoded) return sendText(sock, from, "[ ;﹏; ] No se pudo leer ningún código QR en la imagen kashira.", msg);

        // Sanitización: nunca ejecutamos este contenido, solo lo mostramos como texto plano
        const safeText = String(decoded).slice(0, 1500);
        await sendText(sock, from,
          `*⌞ QR Decodificado ⌝*\n\n` +
          `(o^-')b *Contenido:*\n${safeText}\n\n` +
          `(¬_¬) _Este contenido es solo informativo, nunca lo ejecutes en una terminal ni lo abras si no confías en la fuente._`,
          msg
        );
      } catch (e) {
        await sendText(sock, from, "[ ;﹏; ] Error al leer el QR: " + e.message, msg);
      }
    } else {
      // Modo generación: crear QR a partir de texto/link
      if (!rest) return sendText(sock, from, "[ x_x ] Usa: #qr [texto o link]\n\nO responde/adjunta una imagen con #qr para leer un código QR.", msg);

      try {
        const encodedText = encodeURIComponent(rest.slice(0, 800));
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodedText}`;
        await sock.sendMessage(from, {
          image: { url: qrUrl },
          caption: `*⌞ Código QR ⌝*\n\n(*^.^*) Generado a partir de:\n${rest.slice(0, 200)}`
        }, { quoted: msg });
      } catch (e) {
        await sendText(sock, from, "[ ;﹏; ] Error al generar el QR: " + e.message, msg);
      }
    }
  }

  else if (finalCmd === "timer") {
    const minutesRaw = args[1];
    const minutes = parseFloat(minutesRaw);
    if (!minutesRaw || isNaN(minutes) || minutes <= 0) {
      return sendText(sock, from, "[ x_x ] Usa: #timer [minutos] [motivo (opcional)] kashira.\n\nEjemplo: #timer 10 hervir los huevos", msg);
    }
    if (minutes > 1440) {
      return sendText(sock, from, "[ x_x ] El máximo es 1440 minutos (24 horas) kashira.", msg);
    }

    const motivo = args.slice(2).join(" ").trim() || "Sin motivo especificado";
    const ms = Math.round(minutes * 60 * 1000);
    const displayMinutes = Math.round(minutes * 100) / 100;

    await sendText(sock, from, `[ (o^-')b ] ¡Temporizador iniciado kashira! Duración: *${displayMinutes} min*.\nMotivo: ${motivo}\n\nTe avisaré cuando termine (*^.^*)`, msg);

    setTimeout(async () => {
      try {
        await sock.sendMessage(from, {
          text: `[ ﴾٩(๑❛ᴗ❛๑)۶﴿ ¡TIEMPO! ] @${senderNum} tu temporizador de *${displayMinutes} min* terminó kashira.\nMotivo: ${motivo}`,
          mentions: [sender]
        });
      } catch (e) {
        console.error("[TIMER] Error al avisar:", e.message);
      }
    }, ms);
  }

  else if (finalCmd === "poll") {
    if (!rest) {
      return sendText(sock, from, "[ x_x ] Usa: #poll [pregunta] | [opción 1] | [opción 2] | ...\n\nEjemplo: #poll ¿Pizza o tacos? | Pizza | Tacos", msg);
    }
    const parts = rest.split("|").map(p => p.trim()).filter(Boolean);
    if (parts.length < 3) {
      return sendText(sock, from, "[ x_x ] Necesitas una pregunta y al menos 2 opciones, separadas por *|* kashira.\n\nEjemplo: #poll ¿Pizza o tacos? | Pizza | Tacos", msg);
    }
    const question = parts[0];
    const options = parts.slice(1);
    if (options.length > 12) {
      return sendText(sock, from, "[ x_x ] Máximo 12 opciones kashira.", msg);
    }

    try {
      await sock.sendMessage(from, {
        poll: {
          name: question,
          values: options,
          selectableCount: 1
        }
      }, { quoted: msg });
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] Error al crear la encuesta: " + e.message, msg);
    }
  }

  else if (finalCmd === "define") {
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #define [palabra] kashira.\n\nEjemplo: #define serendipia", msg);
    const word = rest.trim().toLowerCase();

    try {
      const res = await axios.get(`https://rae-api.com/api/words/${encodeURIComponent(word)}`);
      const data = res.data?.data;

      if (!data || !data.meanings?.length) {
        return sendText(sock, from, `[ x_x ] No encontré *${word}* en el diccionario kashira.`, msg);
      }

      let text = `*⌞ Definición: ${data.word} ⌝*\n\n`;
      data.meanings.slice(0, 3).forEach((meaning, mi) => {
        meaning.senses?.slice(0, 3).forEach((sense, si) => {
          const n = mi * 3 + si + 1;
          const cat = sense.category ? `_(${sense.category})_ ` : "";
          text += `${n}. ${cat}${sense.raw || sense.description || ""}\n`;
        });
      });
      text += `━━━━━━━━━━━━━━━━`;

      await sendText(sock, from, text, msg);
    } catch (e) {
      await sendText(sock, from, `[ x_x ] No encontré *${word}* en el diccionario, o hubo un error kashira.`, msg);
    }
  }

  else if (finalCmd === "short") {
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #short [link] kashira.\n\nEjemplo: #short https://ejemplo.com/pagina-muy-larga", msg);

    let url = rest.trim();
    if (!/^https?:\/\//i.test(url)) url = "https://" + url;

    try {
      const res = await axios.get("https://tinyurl.com/api-create.php", { params: { url } });
      const shortUrl = res.data;

      if (!shortUrl || !shortUrl.startsWith("http")) {
        return sendText(sock, from, "[ ;﹏; ] No se pudo acortar ese link kashira, revisa que sea válido.", msg);
      }

      await sendText(sock, from, `*⌞ Link Acortado ⌝*\n\n(o^-')b ${shortUrl}`, msg);
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] Error al acortar el link: " + e.message, msg);
    }
  }

  else if (finalCmd === "encrypt") {
    const parts = rest.trim().split(/\s+/);
    const password = parts[0];
    const text = parts.slice(1).join(" ");

    if (!password || !text) {
      return sendText(sock, from, "[ x_x ] Usa: #encrypt [contraseña] [texto] kashira.\n\nEjemplo: #encrypt miclave123 Este es un mensaje secreto", msg);
    }

    try {
      const encrypted = encryptWithPassword(text, password);
      await sendText(sock, from, `*⌞ Texto Encriptado ⌝*\n\n${encrypted}\n\n_Guárdalo bien kashira, solo se puede recuperar con #decrypt y la misma contraseña._`, msg);
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] Error al encriptar: " + e.message, msg);
    }
  }

  else if (finalCmd === "decrypt") {
    const parts = rest.trim().split(/\s+/);
    const password = parts[0];
    const data = parts.slice(1).join(" ");

    if (!password || !data) {
      return sendText(sock, from, "[ x_x ] Usa: #decrypt [contraseña] [texto encriptado] kashira.", msg);
    }

    try {
      const decrypted = decryptWithPassword(data, password);
      await sendText(sock, from, `*⌞ Texto Desencriptado ⌝*\n\n${decrypted}`, msg);
    } catch (e) {
      await sendText(sock, from, "[ x_x ] No se pudo desencriptar kashira. La contraseña es incorrecta o el texto está mal copiado.", msg);
    }
  }

  else if (finalCmd === "bug" || finalCmd === "suggest") {
    if (!rest) {
      const ejemplo = finalCmd === "bug" ? "#bug el comando #s se traba con videos largos" : "#suggest agreguen un comando para stickers animados con texto";
      return sendText(sock, from, `[ x_x ] Usa: #${rawCmd} [descripción]\n\nEjemplo: ${ejemplo}`, msg);
    }
    db.bugReports = db.bugReports || [];
    db.bugReportCounter = (db.bugReportCounter || 0) + 1;
    const id = db.bugReportCounter;
    const tipo = finalCmd === "bug" ? "bug" : "sugerencia";
    db.bugReports.push({
      id,
      tipo,
      texto: rest,
      senderNum,
      groupJid: isGroup ? from : null,
      fecha: new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" }),
    });
    saveDB(db);
    const label = tipo === "bug" ? "reporte de bug" : "sugerencia";
    await sendText(sock, from, `[ (p^.^q) ] ¡Gracias por tu ${label} kashira! Se guardó como *#${id}*.`, msg);
  }

  // ══════════════════════════════
  //    EDITOR MULTIMEDIA (ffmpeg)
  // ══════════════════════════════

  else if (finalCmd === "comp") {
    const media = getMediaFromMsg(msg, quotedContext);
    if (!media || (media.type !== "video" && media.type !== "image")) {
      return sendText(sock, from, "[ x_x ] Responde a una imagen o video con #comp kashira.", msg);
    }
    try {
      const buffer = await downloadMedia(media.node, media.type);
      if (media.type === "video") {
        const outBuf = await runFfmpeg(buffer, ".mp4", ".mp4", (cmd) => {
          cmd.videoCodec("libx264")
            .outputOptions(["-crf 32", "-preset veryfast", "-vf scale=480:-2"])
            .audioCodec("aac").audioBitrate("64k");
        });
        await sock.sendMessage(from, { video: outBuf, mimetype: "video/mp4", caption: "(o^-')b Video comprimido kashira." }, { quoted: msg });
      } else {
        const outBuf = await runFfmpeg(buffer, ".jpg", ".jpg", (cmd) => {
          cmd.outputOptions(["-q:v 15", "-vf scale=800:-2"]);
        });
        await sock.sendMessage(from, { image: outBuf, caption: "(o^-')b Imagen comprimida kashira." }, { quoted: msg });
      }
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] Error al comprimir: " + e.message, msg);
    }
  }

  else if (finalCmd === "blur") {
    const media = getMediaFromMsg(msg, quotedContext);
    if (!media || (media.type !== "image" && media.type !== "sticker")) {
      return sendText(sock, from, "[ x_x ] Responde a una imagen o sticker con #blur kashira.", msg);
    }
    try {
      const buffer = await downloadMedia(media.node, media.type);
      const outBuf = await runFfmpeg(buffer, media.type === "sticker" ? ".webp" : ".jpg", ".jpg", (cmd) => {
        cmd.outputOptions(["-vf", "boxblur=10:2", "-q:v 3"]);
      });
      await sock.sendMessage(from, { image: outBuf, caption: "(o^-')b Imagen desenfocada kashira." }, { quoted: msg });
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] Error al desenfocar: " + e.message, msg);
    }
  }

  else if (finalCmd === "sharpen") {
    const media = getMediaFromMsg(msg, quotedContext);
    if (!media || (media.type !== "image" && media.type !== "sticker")) {
      return sendText(sock, from, "[ x_x ] Responde a una imagen o sticker con #sharpen kashira.", msg);
    }
    try {
      const buffer = await downloadMedia(media.node, media.type);
      const outBuf = await runFfmpeg(buffer, media.type === "sticker" ? ".webp" : ".jpg", ".jpg", (cmd) => {
        cmd.outputOptions(["-vf", "unsharp=5:5:2.0:5:5:0.0", "-q:v 3"]);
      });
      await sock.sendMessage(from, { image: outBuf, caption: "(o^-')b Nitidez aumentada kashira." }, { quoted: msg });
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] Error al aumentar la nitidez: " + e.message, msg);
    }
  }

  else if (finalCmd === "invert") {
    const media = getMediaFromMsg(msg, quotedContext);
    if (!media || (media.type !== "image" && media.type !== "sticker")) {
      return sendText(sock, from, "[ x_x ] Responde a una imagen o sticker con #invert kashira.", msg);
    }
    try {
      const buffer = await downloadMedia(media.node, media.type);
      const outBuf = await runFfmpeg(buffer, media.type === "sticker" ? ".webp" : ".jpg", ".jpg", (cmd) => {
        cmd.outputOptions(["-vf", "negate", "-q:v 3"]);
      });
      await sock.sendMessage(from, { image: outBuf, caption: "(o^-')b Colores invertidos kashira." }, { quoted: msg });
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] Error al invertir los colores: " + e.message, msg);
    }
  }

  else if (finalCmd === "reverse") {
    const media = getMediaFromMsg(msg, quotedContext);
    if (!media || media.type !== "video") {
      return sendText(sock, from, "[ x_x ] Responde a un video con #reverse kashira.", msg);
    }
    try {
      const buffer = await downloadMedia(media.node, media.type);
      let outBuf;
      try {
        outBuf = await runFfmpeg(buffer, ".mp4", ".mp4", (cmd) => {
          cmd.outputOptions(["-vf", "reverse", "-af", "areverse"]);
        });
      } catch {
        // Si el video no tiene pista de audio, reintenta invirtiendo solo el video.
        outBuf = await runFfmpeg(buffer, ".mp4", ".mp4", (cmd) => {
          cmd.outputOptions(["-vf", "reverse"]);
        });
      }
      await sock.sendMessage(from, { video: outBuf, mimetype: "video/mp4", caption: "(o^-')b Video invertido kashira." }, { quoted: msg });
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] Error al invertir el video: " + e.message, msg);
    }
  }

  else if (finalCmd === "ship") {
    const mentions = (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []).map(j => resolveToPN(j));
    const u1 = mentions[0] || getMentionedJid(msg);
    let u2 = mentions[1] || null;
    if (u1 && !u2) u2 = sender;
    if (!u1 || !u2) return sendText(sock, from, "[ x_x ] Menciona a una o dos personas kashira.\n\nEjemplo: #ship @usuario1 @usuario2\nO: #ship @usuario (se hace contigo)", msg);

    const pct = Math.floor(Math.random() * 101);
    const nivel = pct < 20 ? "rivales eternos" : pct < 40 ? "conocidos nada más" : pct < 60 ? "buenos amigos" : pct < 80 ? "algo está pasando ahí..." : pct < 95 ? "definitivamente novios" : "almas gemelas kashira (>////<)";

    const text = `*⌞ Ship ⌝*\n\n@${u1.split("@")[0]}  +  @${u2.split("@")[0]}\n\n{kao}  {pct}%\n\n_${nivel}_`;
    await animatePct(sock, from, msg, text, pct, path.join(__dirname, "gifs", "ship.mp4"), [u1, u2]);
  }

  else if (finalCmd === "vs") {
    const mentions = (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []).map(j => resolveToPN(j));
    const u1 = mentions[0] || getMentionedJid(msg);
    let u2 = mentions[1] || null;
    if (u1 && !u2) u2 = sender;
    if (!u1 || !u2) return sendText(sock, from, "[ x_x ] Menciona a una o dos personas kashira.\n\nEjemplo: #vs @usuario1 @usuario2\nO: #vs @usuario (se hace contigo)", msg);

    const pct = Math.floor(Math.random() * 101);
    const razones = [
      "tiene mejor estrategia",
      "es más rápido kashira",
      "simplemente no se rinde",
      "tiene más experiencia",
      "la suerte está de su lado hoy",
      "intimidó al rival con solo mirarlo",
      "entrenó más duro kashira",
    ];
    const razon = razones[Math.floor(Math.random() * razones.length)];
    const ganador = pct >= 50 ? u1 : u2;
    const ganadorNum = ganador.split("@")[0];

    const text = `*⌞ VS ⌝*\n\n@${u1.split("@")[0]}  vs  @${u2.split("@")[0]}\n\n{kao}  {pct}% de ventaja\n\n_@${ganadorNum} ganaría porque ${razon} kashira_`;
    await animatePct(sock, from, msg, text, pct, path.join(__dirname, "gifs", "vs.mp4"), [u1, u2, ganador]);
  }

  else if (finalCmd === "best") {
    const mentions = (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []).map(j => resolveToPN(j));
    const u1 = mentions[0] || getMentionedJid(msg);
    let u2 = mentions[1] || null;
    if (u1 && !u2) u2 = sender;
    if (!u1 || !u2) return sendText(sock, from, "[ x_x ] Menciona a una o dos personas kashira.\n\nEjemplo: #best @usuario1 @usuario2\nO: #best @usuario (se hace contigo)", msg);

    const pct = Math.floor(Math.random() * 101);
    const ganador = pct >= 50 ? u1 : u2;
    const perdedor = pct >= 50 ? u2 : u1;
    const cualidades = ["más honesto", "más carismático", "más inteligente kashira", "mejor persona en general", "más confiable", "el favorito de Beatrice (>w<)"];
    const cualidad = cualidades[Math.floor(Math.random() * cualidades.length)];

    const text = `*⌞ Mejor Persona ⌝*\n\n@${u1.split("@")[0]}  vs  @${u2.split("@")[0]}\n\n{kao}  {pct}%\n\n_@${ganador.split("@")[0]} es ${cualidad} que @${perdedor.split("@")[0]} kashira_`;
    await animatePct(sock, from, msg, text, pct, path.join(__dirname, "gifs", "mejor.mp4"), [u1, u2]);
  }

  else if (finalCmd === "rat") {
    const target = resolveMentionOrNick(db, msg, senderNum, rest) || sender;
    const targetNum = target.split("@")[0];
    const pct = Math.floor(Math.random() * 101);
    const nivel = pct < 20 ? "completamente honesto, me sorprende kashira" : pct < 40 ? "algo sospechoso pero tolerable" : pct < 60 ? "claramente esconde algo kashira" : pct < 80 ? "rata de primera clase" : pct < 95 ? "rata de alcantarilla kashira (°_°)" : "la rata definitiva, huyamos todos [X_X]";

    const text = `*⌞ Detector de Ratas ⌝*\n\n@${targetNum}\n\n{kao}  {pct}% rata\n\n_${nivel}_`;
    await animatePct(sock, from, msg, text, pct, path.join(__dirname, "gifs", "rata.mp4"), [target]);
  }

  else if (finalCmd === "simp") {
    const target = resolveMentionOrNick(db, msg, senderNum, rest) || sender;
    const targetNum = target.split("@")[0];
    const pct = Math.floor(Math.random() * 101);
    const nivel = pct < 20 ? "nada de simp, qué alivio kashira" : pct < 40 ? "levemente simp pero controlable" : pct < 60 ? "simp moderado, ten cuidado kashira" : pct < 80 ? "simp avanzado, sin remedio casi" : pct < 95 ? "simp de clase mundial kashira (>_<)" : "simp absoluto, caso perdido [X_X]";

    const text = `*⌞ Detector de Simps ⌝*\n\n@${targetNum}\n\n{kao}  {pct}% simp\n\n_${nivel}_`;
    await animatePct(sock, from, msg, text, pct, path.join(__dirname, "gifs", "simp.mp4"), [target]);
  }

  // ══════════════════════════════
  //    ACCIONES DE ANIME (OtakuGifs)
  // ══════════════════════════════
  else if (ANIME_ACTIONS[finalCmd]) {
    const action = ANIME_ACTIONS[finalCmd];
    const mentions = (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []).map(j => resolveToPN(j));
    const u1 = sender;
    const u2 = mentions[0] || getMentionedJid(msg) || null;
    const isPair = !!u2;

    try {
      const { data } = await axios.get(`https://api.otakugifs.xyz/gif?reaction=${action.reaction}&format=gif`);
      if (!data?.url) throw new Error("La API no devolvió un gif válido");

      const buffer = await getAnimeGifMp4(data.url);

      const pool = isPair ? ANIME_PAIR_TEMPLATES : ANIME_SOLO_TEMPLATES;
      const verb = resolveGenderedText(isPair ? action.pair : action.solo, db, senderNum);
      const text = pick(pool)
        .replace("{u1}", `@${u1.split("@")[0]}`)
        .replace("{verb}", verb)
        .replace("{u2}", u2 ? `@${u2.split("@")[0]}` : "");

      await sock.sendMessage(from, {
        video: buffer,
        gifPlayback: true,
        caption: `*⌞ ${action.label} ⌝*\n\n${text}`,
        mentions: isPair ? [u1, u2] : [u1],
      }, { quoted: msg });
    } catch (e) {
      await sendText(sock, from, "[ x_x ] Error al obtener el gif kashira: " + e.message, msg);
    }
  }

  else if (finalCmd === "owoify") {
    if (!rest.trim()) return sendText(sock, from, "[ x_x ] Usa: #owoify [texto] kashira.\n\nEjemplo: #owoify hola, ¿cómo estás?", msg);
    await sendText(sock, from, owoifyFull(rest.trim()), msg);
  }

  else if (finalCmd === "iq") {
    const target = resolveMentionOrNick(db, msg, senderNum, rest) || sender;
    const targetNum = target.split("@")[0];
    const pct = Math.floor(Math.random() * 201);
    const nivel = pct < 40 ? "... kashira (._.) mejor no decir nada" : pct < 70 ? "por debajo del promedio kashira" : pct < 100 ? "normalito, nada especial" : pct < 130 ? "inteligente kashira (o^.^o)" : pct < 160 ? "muy por encima del promedio kashira!" : pct < 185 ? "genio reconocido kashira (*O*)" : "IQ imposible... ¿es humano esto? kashira (((*°▽°*)))";

    const text = `*⌞ Medidor de IQ ⌝*\n\n@${targetNum}\n\n{kao}  IQ: {pct}\n\n_${nivel}_`;
    await animatePct(sock, from, msg, text, pct, path.join(__dirname, "gifs", "iq.mp4"), [target]);
  }

  else if (finalCmd === "gay") {
    const target = resolveMentionOrNick(db, msg, senderNum, rest) || sender;
    const targetNum = target.split("@")[0];
    const pct = Math.floor(Math.random() * 101);
    const nivel = pct < 20 ? "nada gay, cero kashira" : pct < 40 ? "un poquito nomás" : pct < 60 ? "mitad y mitad kashira" : pct < 80 ? "bastante gay kashira (o^.^o)" : pct < 95 ? "muy gay kashira (>////<)" : "gay definitivo, sin dudas kashira (✧∀✧)";

    const text = `*⌞ Detector Gay ⌝*\n\n@${targetNum}\n\n{kao}  {pct}%\n\n_${nivel}_`;
    await animatePct(sock, from, msg, text, pct, path.join(__dirname, "gifs", "gay.mp4"), [target]);
  }

  else if (finalCmd === "lesbian") {
    const target = resolveMentionOrNick(db, msg, senderNum, rest) || sender;
    const targetNum = target.split("@")[0];
    const pct = Math.floor(Math.random() * 101);
    const nivel = pct < 20 ? "nada lesbiana, cero kashira" : pct < 40 ? "un poquito nomás" : pct < 60 ? "mitad y mitad kashira" : pct < 80 ? "bastante lesbiana kashira (o^.^o)" : pct < 95 ? "muy lesbiana kashira (>////<)" : "lesbiana definitiva, sin dudas kashira (✧∀✧)";

    const text = `*⌞ Detector Lésbico ⌝*\n\n@${targetNum}\n\n{kao}  {pct}%\n\n_${nivel}_`;
    await animatePct(sock, from, msg, text, pct, path.join(__dirname, "gifs", "lesbian.mp4"), [target]);
  }

  else if (finalCmd === "bisexual") {
    const target = resolveMentionOrNick(db, msg, senderNum, rest) || sender;
    const targetNum = target.split("@")[0];
    const pct = Math.floor(Math.random() * 101);
    const nivel = pct < 20 ? "nada bi, cero kashira" : pct < 40 ? "un poquito nomás" : pct < 60 ? "mitad y mitad kashira" : pct < 80 ? "bastante bi kashira (o^.^o)" : pct < 95 ? "muy bi kashira (>////<)" : "bi definitivo, sin dudas kashira (✧∀✧)";

    const text = `*⌞ Detector Bisexual ⌝*\n\n@${targetNum}\n\n{kao}  {pct}%\n\n_${nivel}_`;
    await animatePct(sock, from, msg, text, pct, path.join(__dirname, "gifs", "bisexual.mp4"), [target]);
  }

  else if (finalCmd === "freaky") {
    const target = resolveMentionOrNick(db, msg, senderNum, rest) || sender;
    const targetNum = target.split("@")[0];
    const pct = Math.floor(Math.random() * 101);
    const nivel = pct < 20 ? "inocente total kashira (o.o)" : pct < 40 ? "levemente freaky" : pct < 60 ? "freaky moderado kashira" : pct < 80 ? "bastante freaky kashira (>_<)" : pct < 95 ? "muy freaky kashira (////)" : "freaky definitivo, cuidado kashira [X_X]";

    const text = `*⌞ Detector Freaky ⌝*\n\n@${targetNum}\n\n{kao}  {pct}%\n\n_${nivel}_`;
    await animatePct(sock, from, msg, text, pct, path.join(__dirname, "gifs", "freaky.mp4"), [target]);
  }

  else if (finalCmd === "otaku") {
    const target = resolveMentionOrNick(db, msg, senderNum, rest) || sender;
    const targetNum = target.split("@")[0];
    const pct = Math.floor(Math.random() * 101);
    const nivel = pct < 20 ? "casi no conoce el anime kashira" : pct < 40 ? "otaku casual nomás" : pct < 60 ? "otaku moderado kashira" : pct < 80 ? "otaku de verdad kashira (o^.^o)" : pct < 95 ? "otaku de closet lleno de figuras" : "otaku definitivo, kashira reconocida (*O*)";

    const text = `*⌞ Detector Otaku ⌝*\n\n@${targetNum}\n\n{kao}  {pct}%\n\n_${nivel}_`;
    await animatePct(sock, from, msg, text, pct, path.join(__dirname, "gifs", "otaku.mp4"), [target]);
  }

  else if (finalCmd === "funny") {
    const target = resolveMentionOrNick(db, msg, senderNum, rest) || sender;
    const targetNum = target.split("@")[0];
    const pct = Math.floor(Math.random() * 101);
    const nivel = pct < 20 ? "cero gracia, lo siento kashira (._.)" : pct < 40 ? "algo de gracia nomás" : pct < 60 ? "gracioso moderado kashira" : pct < 80 ? "bastante gracioso kashira (^▽^)" : pct < 95 ? "muy gracioso kashira jajaja" : "el comediante definitivo kashira (≧▽≦)";

    const text = `*⌞ Detector de Gracia ⌝*\n\n@${targetNum}\n\n{kao}  {pct}%\n\n_${nivel}_`;
    await animatePct(sock, from, msg, text, pct, path.join(__dirname, "gifs", "funny.mp4"), [target]);
  }

  else if (finalCmd === "eightball") {
    if (!rest) return sendText(sock, from, "[ x_x ] Hazme una pregunta kashira.\n\nEjemplo: #8ball ¿me va a ir bien hoy?", msg);
    const answer = pick(EIGHTBALL_ANSWERS);
    await sendText(sock, from, `*⌞ Bola 8 ⌝*\n\n(o^.^o) *Pregunta:* ${rest}\n\n(✦ω✦) *Respuesta:* ${answer}`, msg);
  }

  else if (finalCmd === "wouldyourather") {
    const question = pick(WOULDYOURATHER_QUESTIONS);
    await sendText(sock, from, `*⌞ ¿Qué Preferirías? ⌝*\n\n(・_・?) ${question}`, msg);
  }

  else if (finalCmd === "math") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos kashira.", msg);
    if (pendingChallenges[from]) return sendText(sock, from, "[ (¬_¬) ] Ya hay un reto activo en este grupo kashira, respóndanlo primero.", msg);

    db.lastChallenge = db.lastChallenge || {};
    const chElapsed = Date.now() - (db.lastChallenge[from] || 0);
    if (chElapsed < CHALLENGE_COOLDOWN_MS) {
      return sendText(sock, from, `[ (¬_¬) ] Espera *${fmtCooldown(CHALLENGE_COOLDOWN_MS - chElapsed)}* antes del siguiente reto en este grupo kashira.`, msg);
    }

    const { expr, answer } = generateMathQuestion();
    const reward = randInt(CHALLENGE_REWARD_MIN, CHALLENGE_REWARD_MAX);

    const timeout = setTimeout(async () => {
      clearChallenge(from);
      await sendText(sock, from, `[ (._.) ] Se acabó el tiempo kashira, nadie respondió a tiempo.\n\n*Operación:* ${expr}\n*Respuesta:* ${answer}`, msg).catch(() => {});
    }, CHALLENGE_TIMEOUT_MS);

    pendingChallenges[from] = { type: "math", answer: String(answer), reward, timeout };
    db.lastChallenge[from] = Date.now();
    saveDB(db);

    await sendText(sock, from, `*⌞ Matemáticas ⌝*\n\n(p^.^q) Resuelve rápido, el primero en responder bien gana *${fmtM(reward)}* kashira:\n\n*${expr} = ?*\n\n_Tienes 30 segundos._`, msg);
  }

  else if (finalCmd === "trivia") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos kashira.", msg);
    if (pendingChallenges[from]) return sendText(sock, from, "[ (¬_¬) ] Ya hay un reto activo en este grupo kashira, respóndanlo primero.", msg);

    db.lastChallenge = db.lastChallenge || {};
    const trivChElapsed = Date.now() - (db.lastChallenge[from] || 0);
    if (trivChElapsed < CHALLENGE_COOLDOWN_MS) {
      return sendText(sock, from, `[ (¬_¬) ] Espera *${fmtCooldown(CHALLENGE_COOLDOWN_MS - trivChElapsed)}* antes del siguiente reto en este grupo kashira.`, msg);
    }

    const catInput = normalizeText(rest);
    const categories = Object.keys(TRIVIA_QUESTIONS);
    const category = categories.includes(catInput) ? catInput : pick(categories);
    const item = pick(TRIVIA_QUESTIONS[category]);
    const xpReward = randInt(TRIVIA_XP_MIN, TRIVIA_XP_MAX);
    const moneyReward = randInt(TRIVIA_REWARD_MIN, TRIVIA_REWARD_MAX);

    const timeout = setTimeout(async () => {
      clearChallenge(from);
      await sendText(sock, from, `[ (._.) ] Se acabó el tiempo kashira, nadie respondió a tiempo.\n\n*Pregunta:* ${item.q}\n*Respuesta:* ${item.a}`, msg).catch(() => {});
    }, CHALLENGE_TIMEOUT_MS);

    pendingChallenges[from] = { type: "trivia", answer: normalizeText(item.a), xpReward, moneyReward, timeout };
    db.lastChallenge[from] = Date.now();
    saveDB(db);

    await sendText(sock, from, `*⌞ Trivia: ${category} ⌝*\n\n(o^-')b El primero en responder bien gana *${fmtM(moneyReward)}* y *${xpReward} XP* kashira:\n\n*${item.q}*\n\n_Tienes 30 segundos, se acepta un pequeño margen de error en la respuesta. Categorías: ${categories.join(", ")}_`, msg);
  }

  else if (finalCmd === "p") {
    const start = Date.now();
    const sentMsg = await sock.sendMessage(from, { text: "[ (p^.^q) ] Midiendo respuesta..." }, { quoted: msg });
    const latency = Date.now() - start;
    await sock.sendMessage(from, {
      text: `[ ¡Pong kashira! ]\n(o^-')b Latencia: *${latency}ms*`,
      edit: sentMsg.key,
    });
  }

  else if (finalCmd === "toimg") {
    const stickerMsg = msgContent?.stickerMessage || quotedContext?.stickerMessage;
    const imageMsg = msgContent?.imageMessage || quotedContext?.imageMessage;
    if (!stickerMsg && !imageMsg) return sendText(sock, from, "(^o^) Debes responder a un sticker o imagen kashira.", msg);

    try {
      const buffer = stickerMsg
        ? await downloadMedia(stickerMsg, "sticker")
        : await downloadMedia(imageMsg, "image");
      const cleanJpgBuffer = await convertToJpgWithFfmpeg(buffer, stickerMsg ? ".webp" : ".jpg");

      await sock.sendMessage(from, { image: cleanJpgBuffer, caption: "(*~▽~)☆ ¡Aquí tienes tu imagen procesada kashira!" }, { quoted: msg });
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] Error al procesar conversión: " + e.message, msg);
    }
  }

  else if (finalCmd === "tomp3") {
    const media = getMediaFromMsg(msg, quotedContext);
    if (!media || (media.type !== "video" && media.type !== "audio")) {
      return sendText(sock, from, "[ x_x ] Responde a un video o audio con #tomp3 kashira.", msg);
    }
    try {
      const buffer = await downloadMedia(media.node, media.type);
      const inExt = media.type === "video" ? ".mp4" : ".ogg";
      const outBuf = await runFfmpeg(buffer, inExt, ".mp3", (cmd) => {
        cmd.noVideo().audioCodec("libmp3lame").audioBitrate("128k");
      });
      await sock.sendMessage(from, { audio: outBuf, mimetype: "audio/mpeg" }, { quoted: msg });
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] Error al extraer audio: " + e.message, msg);
    }
  }


  // ══════════════════════════════
  //    ADMINISTRACIÓN
  // ══════════════════════════════

  else if (finalCmd === "tag") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo administradores pueden usar #tag.", msg);
    const meta = await sock.groupMetadata(from);
    updateLidMapFromMeta(meta);
    const participants = meta.participants.map(p => {
      const pn = p.pn || p.phoneNumber;
      if (pn) return pn.includes("@") ? pn : pn + "@s.whatsapp.net";
      return resolveToPN(p.id);
    });

    // Si el mensaje trae (o cita) una imagen, video o sticker, se manda ese medio con el
    // texto de caption; si no hay nada adjunto, es el #tag clásico de solo texto.
    const imageMsg = msgContent?.imageMessage || quotedContext?.imageMessage;
    const videoMsg = msgContent?.videoMessage || quotedContext?.videoMessage;
    const stickerMsg = msgContent?.stickerMessage || quotedContext?.stickerMessage;

    const rawText = rest ? rest : "[ (•ิ_•ิ) ] ¡Atención a todos kashira! Aquí un llamado general para el grupo.";
    // Si alguien fue mencionado dentro del texto, se corrigen los dígitos crudos (que a
    // veces son el LID) para que la mención se vea bien marcada y no como número pelón.
    const text = normalizeMentionsInText(msg, rawText);

    try {
      if (imageMsg) {
        const buffer = await downloadMedia(imageMsg, "image");
        await sock.sendMessage(from, { image: buffer, caption: text, mentions: participants }, { quoted: msg });
      } else if (videoMsg) {
        const buffer = await downloadMedia(videoMsg, "video");
        await sock.sendMessage(from, { video: buffer, caption: text, mentions: participants }, { quoted: msg });
      } else if (stickerMsg) {
        const buffer = await downloadMedia(stickerMsg, "sticker");
        await sock.sendMessage(from, { sticker: buffer, mentions: participants }, { quoted: msg });
        if (rest) await sock.sendMessage(from, { text, mentions: participants }, { quoted: msg });
      } else {
        await sock.sendMessage(from, { text, mentions: participants }, { quoted: msg });
      }
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] Error al mandar el tag: " + e.message, msg);
    }
  }

  else if (finalCmd === "prom") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo administradores.", msg);
    const target = resolveToPN(getMentionedJid(msg));
    if (!target) return sendText(sock, from, "[x_x] Debes mencionar o responder a alguien kashira~", msg);
    const targetPN = resolveToPN(target);
    const res = await safeGroupParticipantsUpdate(sock, from, targetPN, "promote");
    if (!res.ok) {
      return sendText(sock, from, res.notBotAdmin
        ? "[ x_x ] No pude hacerlo kashira, revisa que YO (Beatrice) sea admin del grupo."
        : "[ x_x ] Esa persona ya no está en el grupo kashira.", msg);
    }
    await sock.sendMessage(from, { text: `[$_$] @${targetPN.split("@")[0]} Ahora es admin kashira. (*~▽~)☆`, mentions: [targetPN] }, { quoted: msg });
  }

  else if (finalCmd === "dem") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo administradores.", msg);
    const target = resolveToPN(getMentionedJid(msg));
    if (!target) return sendText(sock, from, "[x_x] Debes mencionar o responder a alguien kashira", msg);
    const targetPN = resolveToPN(target);
    const res = await safeGroupParticipantsUpdate(sock, from, targetPN, "demote");
    if (!res.ok) {
      return sendText(sock, from, res.notBotAdmin
        ? "[ x_x ] No pude hacerlo kashira, revisa que YO (Beatrice) sea admin del grupo."
        : "[ x_x ] Esa persona ya no está en el grupo kashira.", msg);
    }
    await sock.sendMessage(from, { text: `[#_#] @${targetPN.split("@")[0]} Degradado de su puesto. (x_x)`, mentions: [targetPN] }, { quoted: msg });
  }

  else if (finalCmd === "desc") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo admins pueden usar esto kashira.", msg);
    
    // Usamos la misma lógica que en #setwel para capturar el texto crudo
    const prefixLen = CONFIG.prefix.length;
    const cmdLen = finalCmd.length;
    const newDesc = body.slice(prefixLen + cmdLen).trim();

    if (!newDesc) return sendText(sock, from, "[ x_x ] Usa: #desc [nueva descripción]", msg);

    try {
      // Al usar newDesc, conservamos los \n originales que vienen del mensaje
      await sock.groupUpdateDescription(from, newDesc);
      await sendText(sock, from, "[ (o^-')b ] Descripción actualizada kashira!", msg);
    } catch (e) {
      await sendText(sock, from, "[ x_x ] Falló: " + e.message, msg);
    }
  }
 

  else if (finalCmd === "gname") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo admins pueden usar esto kashira.", msg);
    
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #gname [nuevo nombre]", msg);

    try {
      await sock.groupUpdateSubject(from, rest.trim());
      await sendText(sock, from, "[ (o^-')b ] Nombre actualizado kashira!", msg);
    } catch (e) {
      await sendText(sock, from, "[ x_x ] Falló al actualizar: " + e.message, msg);
    }
  }


else if (finalCmd === "gi") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);

    try {
        const meta = await sock.groupMetadata(from);
        const adminList = meta.participants.filter((p) => p.admin);
        const admins = adminList.length
            ? adminList.map((p) => `▸ @${p.id.split("@")[0]}`).join("\n")
            : "_Sin admins registrados kashira._";

        let pp;
        try {
            pp = await sock.profilePictureUrl(from, 'image');
        } catch (e) {
            // Si el grupo no tiene foto, intenta obtener la del bot
            try {
                pp = await sock.profilePictureUrl(sock.user.id, 'image');
            } catch (err) {
                pp = 'https://telegra.ph/file/24fa902ead26340f3df2c.png';
            }
        }

        // ── Info de comunidad ──
        // meta.isCommunity: este mismo grupo ES el grupo principal de una comunidad.
        // meta.linkedParent: este grupo es un subgrupo enlazado a una comunidad (traemos su nombre).
        let communityLine;
        if (meta.isCommunity) {
            communityLine = `[ (っ˘ω˘ς) ] *Comunidad:* este es el grupo principal de una comunidad kashira.`;
        } else if (meta.linkedParent) {
            let communityName = "una comunidad";
            try {
                const parentMeta = await sock.groupMetadata(meta.linkedParent);
                communityName = parentMeta.subject;
            } catch {}
            communityLine = `[ (っ˘ω˘ς) ] *Comunidad:* este grupo pertenece a *${communityName}* kashira.`;
        } else {
            communityLine = `[ (っ˘ω˘ς) ] *Comunidad:* no pertenece a ninguna comunidad kashira.`;
        }

        const creation = meta.creation
            ? new Date(meta.creation * 1000).toLocaleDateString("es-MX", { timeZone: "America/Mexico_City" })
            : "Desconocida";

        const descText = meta.desc && meta.desc.trim()
            ? meta.desc.trim().slice(0, 200)
            : "_Sin descripción kashira._";

        const caption = `*⌞ Info del Grupo ⌝*\n` +
            `━━━━━━━━━━━━━━━━\n\n` +
            `[ (o^-')b ] *Nombre:* ${meta.subject}\n\n` +
            `[ (๑˃ᴗ˂)ﻭ ] *Creado:* ${creation}\n\n` +
            `[ (p^.^q) ] *Miembros:* ${meta.participants.length}\n\n` +
            `${communityLine}\n\n` +
            `[ (⁠｡⁠•̀⁠ᴗ⁠-⁠)⁠✧ ] *Descripción:*\n${descText}\n\n` +
            `[ (•ิ_•ิ) ] *Admins (${adminList.length}):*\n${admins}\n\n` +
            `━━━━━━━━━━━━━━━━`;

        await sock.sendMessage(from, {
            image: { url: pp },
            caption: caption,
            mentions: adminList.map((p) => p.id),
        }, { quoted: msg });

    } catch (error) {
        console.error("Error en comando gi:", error);
        await sendText(sock, from, "[ ! ] Hubo un error al obtener la info.", msg);
    }
}


  else if (finalCmd === "createprofile") {
    if (senderNum && !db.profiles?.[senderNum]) {
      db.profiles = db.profiles || {};
      db.profiles[senderNum] = {
        name: msg.pushName || senderNum,
        gender: null,
        desc: null,
        pfp: null,
        birth: null,
        privacy: "public",
        partner: null,
        pendingMarry: null,
        marriedAt: null,
        kids: [],
        pet: null,
        createdAt: Date.now(),
        stats: { totalCmds: 0 },
        groupStats: {},
        level: 1,
        xp: 0,
      };
      saveDB(db);
      await sock.sendMessage(from, {
        text: `*⌞ Perfil Creado ⌝*\n━━━━━━━━━━━━━━━━\n\n[ (*^.^*) ] ¡Bienvenido/a @${senderNum} kashira!\n\nYa puedes personalizar tu perfil con:\n\n(o^-')b #setname [nombre]\n(p^.^q) #setgender [género]\n(*^.^*) #profiledesc [texto]\n(>////<) #profilepfp + imagen\n(^w^) #setbirth dd/mm/yyyy\n(¬_¬) #setprofile pub/priv\n\n━━━━━━━━━━━━━━━━\n¡Kashira!`,
        mentions: [sender]
      }, { quoted: msg });
    } else {
      await sock.sendMessage(from, {
        text: `[ (¬_¬) ] @${senderNum} ya tienes un perfil kashira, usa #profile para verlo.`,
        mentions: [sender]
      }, { quoted: msg });
    }
  }

  else if (finalCmd === "setname") {
    if (!db.profiles?.[senderNum]) return sendText(sock, from, "[ x_x ] Primero crea tu perfil con #createprofile kashira.", msg);
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #setname [nombre] kashira.", msg);
    db.profiles[senderNum].name = rest.slice(0, 30);
    saveDB(db);
    await sock.sendMessage(from, {
      text: `[ (*^.^*) ] ¡Nombre actualizado a *${rest.slice(0, 30)}* kashira @${senderNum}!`,
      mentions: [sender]
    }, { quoted: msg });
  }

  else if (finalCmd === "setgender") {
    if (!db.profiles?.[senderNum]) return sendText(sock, from, "[ x_x ] Primero crea tu perfil con #createprofile kashira.", msg);
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #setgender [género] kashira.", msg);
    db.profiles[senderNum].gender = rest.slice(0, 20);
    saveDB(db);
    await sock.sendMessage(from, {
      text: `[ (o^-')b ] ¡Género actualizado a *${rest.slice(0, 20)}* kashira @${senderNum}!`,
      mentions: [sender]
    }, { quoted: msg });
  }

  else if (finalCmd === "profiledesc") {
    if (!db.profiles?.[senderNum]) return sendText(sock, from, "[ x_x ] Primero crea tu perfil con #createprofile kashira.", msg);
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #profiledesc [descripción] kashira.", msg);
    db.profiles[senderNum].desc = rest.slice(0, 150);
    saveDB(db);
    await sock.sendMessage(from, {
      text: `[ (*^.^*) ] ¡Descripción actualizada kashira @${senderNum}!`,
      mentions: [sender]
    }, { quoted: msg });
  }

  else if (finalCmd === "favorite") {
    if (!db.profiles?.[senderNum]) return sendText(sock, from, "[ x_x ] Primero crea tu perfil con #createprofile kashira.", msg);

    const parts = rest.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) {
      const favs = db.profiles[senderNum].favorites || {};
      const keys = Object.keys(favs);
      if (!keys.length) {
        return sendText(sock, from, "[ x_x ] No tienes favoritos guardados kashira.\n\nUsa: #favorite [categoría] [texto]\n\nEjemplos:\n#favorite personaje Rem\n#favorite anime Re:Zero\n#favorite juego Elden Ring", msg);
      }
      const list = keys.map(k => ` > *${k}:* ${favs[k]}`).join("\n");
      return sendText(sock, from, `*⌞ Tus Favoritos ⌝*\n\n${list}`, msg);
    }

    const category = normalizeText(parts[0]).slice(0, 20);
    const value = parts.slice(1).join(" ").slice(0, 80);
    if (!value) {
      return sendText(sock, from, "[ x_x ] Usa: #favorite [categoría] [texto] kashira.\n\nEjemplos:\n#favorite personaje Rem\n#favorite anime Re:Zero\n#favorite juego Elden Ring", msg);
    }

    db.profiles[senderNum].favorites = db.profiles[senderNum].favorites || {};
    db.profiles[senderNum].favorites[category] = value;
    saveDB(db);
    await sendText(sock, from, `[ (⁠｡⁠•̀⁠ᴗ⁠-⁠)⁠✧ ] Guardé tu *${category}* favorito como *${value}* kashira. Se mostrará en tu #profile.`, msg);
  }

  else if (finalCmd === "profilepfp") {
    if (!db.profiles?.[senderNum]) return sendText(sock, from, "[ x_x ] Primero crea tu perfil con #createprofile kashira.", msg);
    const imgMsg = msg.message?.imageMessage || quotedContext?.imageMessage;
    if (!imgMsg) return sendText(sock, from, "[ x_x ] Adjunta o responde a una imagen kashira.", msg);
    try {
      const buffer = await downloadMedia(imgMsg, "image");
      // Se sube a catbox.moe en vez de guardarse en el disco del servidor, así el
      // espacio local no crece con cada foto de perfil que la gente vaya poniendo.
      const url = await uploadToCatbox(buffer, `pfp_${senderNum}.jpg`);
      db.profiles[senderNum].pfp = url;
      saveDB(db);
      await sock.sendMessage(from, {
        text: `[ (*>////<) ] ¡Foto de perfil actualizada kashira @${senderNum}!`,
        mentions: [sender]
      }, { quoted: msg });
    } catch (e) {
      await sendText(sock, from, `[ ;﹏; ] Error al guardar la foto kashira: ${e.message}`, msg);
    }
  }

  else if (finalCmd === "setbirth") {
    if (!db.profiles?.[senderNum]) return sendText(sock, from, "[ x_x ] Primero crea tu perfil con #createprofile kashira.", msg);
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #setbirth dd/mm/yyyy kashira.", msg);
    const parts = rest.split("/");
    if (parts.length !== 3 || parts.some(p => isNaN(p))) return sendText(sock, from, "[ x_x ] Formato inválido kashira. Usa: #setbirth dd/mm/yyyy", msg);
    const [d, m, y] = parts.map(Number);
    const date = new Date(y, m - 1, d);
    if (isNaN(date.getTime()) || date > new Date()) return sendText(sock, from, "[ x_x ] Fecha inválida kashira.", msg);
    db.profiles[senderNum].birth = `${String(d).padStart(2,"0")}/${String(m).padStart(2,"0")}/${y}`;
    saveDB(db);
    await sock.sendMessage(from, {
      text: `[ (^w^) ] ¡Fecha de nacimiento guardada kashira @${senderNum}!`,
      mentions: [sender]
    }, { quoted: msg });
  }

  else if (finalCmd === "setprofile") {
    if (!db.profiles?.[senderNum]) return sendText(sock, from, "[ x_x ] Primero crea tu perfil con #createprofile kashira.", msg);
    const mode = rest.toLowerCase();
    if (mode !== "pub" && mode !== "priv" && mode !== "public" && mode !== "privado") {
      return sendText(sock, from, "[ x_x ] Usa: #setprofile pub  o  #setprofile priv kashira.", msg);
    }
    db.profiles[senderNum].privacy = (mode === "pub" || mode === "public") ? "public" : "private";
    saveDB(db);
    await sock.sendMessage(from, {
      text: `[ (¬_¬) ] Perfil de @${senderNum} puesto en *${db.profiles[senderNum].privacy === "public" ? "público (o^-')b" : "privado (¬_¬)"}* kashira!`,
      mentions: [sender]
    }, { quoted: msg });
  }

  else if (finalCmd === "marry") {
    if (!db.profiles?.[senderNum]) return sendText(sock, from, "[ x_x ] Primero crea tu perfil con #createprofile kashira.", msg);

    const isAccept = rest.toLowerCase().startsWith("accept");
    const target = resolveMentionOrNick(db, msg, senderNum, rest);
    const targetNum = target ? findProfileNum(db, target) || target.split("@")[0].split(":")[0] : null;

    if (isAccept) {
      if (!target) return sendText(sock, from, "[ x_x ] Menciona a quien te propuso kashira.\n\nUsa: #marry accept @usuario", msg);
      if (!db.profiles?.[targetNum]) return sendText(sock, from, "[ x_x ] Esa persona no tiene perfil kashira.", msg);
      // pendingMarry se guarda en el perfil de quien RECIBE la propuesta (el que acepta ahora es senderNum),
      // por lo que hay que comprobarlo y limpiarlo en el propio perfil de senderNum, no en el de targetNum.
      if (db.profiles[senderNum].pendingMarry !== targetNum) return sendText(sock, from, "[ x_x ] Esa persona no te ha propuesto matrimonio kashira.", msg);
      if (db.profiles[senderNum].partner) return sendText(sock, from, `[ x_x ] Ya estás ${genderWord(db.profiles[senderNum], "casado")} kashira, usa #divorce primero.`, msg);
      if (db.profiles[targetNum].partner) return sendText(sock, from, `[ x_x ] Esa persona ya está ${genderWord(db.profiles[targetNum], "casado")} kashira.`, msg);

      db.profiles[senderNum].partner = targetNum;
      db.profiles[targetNum].partner = senderNum;
      db.profiles[senderNum].pendingMarry = null;
      db.profiles[senderNum].marriedAt = Date.now();
      db.profiles[targetNum].marriedAt = Date.now();
      saveDB(db);

      await sock.sendMessage(from, {
        text: `*⌞ (>////<) Matrimonio ⌝*\n━━━━━━━━━━━━━━━━\n\n[ (*>////<) ] ¡@${senderNum} y @${targetNum} ahora están casados kashira!\n\n(*^.^*) ¡Que sean muy felices!\n\n━━━━━━━━━━━━━━━━\n¡Kashira!`,
        mentions: [sender, target]
      }, { quoted: msg });

    } else {
      if (!target) return sendText(sock, from, "[ x_x ] Menciona a quien quieres proponerle kashira.\n\nUsa: #marry @usuario", msg);
      if (!db.profiles?.[targetNum]) return sendText(sock, from, "[ x_x ] Esa persona no tiene perfil kashira.", msg);
      if (db.profiles[senderNum].partner) return sendText(sock, from, `[ x_x ] Ya estás ${genderWord(db.profiles[senderNum], "casado")} kashira, usa #divorce primero.`, msg);
      if (db.profiles[targetNum].partner) return sendText(sock, from, `[ x_x ] Esa persona ya está ${genderWord(db.profiles[targetNum], "casado")} kashira.`, msg);
      if (targetNum === senderNum) return sendText(sock, from, `[ x_x ] No puedes casarte contigo ${genderWord(db.profiles[senderNum], "mismo")} kashira... °﹏°`, msg);

      db.profiles[targetNum].pendingMarry = senderNum;
      saveDB(db);

      await sock.sendMessage(from, {
        text: `*⌞ (>////<) Propuesta de Matrimonio ⌝*\n━━━━━━━━━━━━━━━━\n\n[ (>////<) ] @${targetNum}, ¡@${senderNum} te está proponiendo matrimonio kashira!\n\n(^w^) Para aceptar responde:\n*#marry accept @${senderNum}*\n\n━━━━━━━━━━━━━━━━\n¡Kashira!`,
        mentions: [target, sender]
      }, { quoted: msg });
    }
  }

  else if (finalCmd === "afk") {
    const reason = rest.trim();
    if (["off", "back", "quitar"].includes(normalizeText(reason))) {
      if (db.afk?.[senderNum]) {
        delete db.afk[senderNum];
        saveDB(db);
        return sendText(sock, from, "[ (o^-')b ] Listo, ya no estás AFK kashira.", msg);
      }
      return sendText(sock, from, "[ (._.) ] No estabas AFK kashira.", msg);
    }
    db.afk = db.afk || {};
    db.afk[senderNum] = { reason: reason || null, since: Date.now() };
    saveDB(db);
    await sendText(sock, from, `[ (-_-) ] Listo kashira, quedas como AFK${reason ? `: _${reason}_` : ""}. En cuanto vuelvas a escribir se te quita solo.`, msg);
  }

  else if (finalCmd === "couples") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    const meta = await sock.groupMetadata(from).catch(() => null);
    if (!meta) return sendText(sock, from, "[ x_x ] No pude leer los participantes de este grupo kashira.", msg);
    const memberNums = new Set(meta.participants.map(p => resolveToPN(p.id).split("@")[0].split(":")[0]));

    const seen = new Set();
    const couples = [];
    for (const [num, prof] of Object.entries(db.profiles || {})) {
      if (!prof.partner || seen.has(num)) continue;
      const partnerNum = prof.partner;
      if (!db.profiles?.[partnerNum] || seen.has(partnerNum)) continue;
      if (!memberNums.has(num) || !memberNums.has(partnerNum)) continue;
      seen.add(num); seen.add(partnerNum);
      couples.push({ a: prof.name || num, b: db.profiles[partnerNum].name || partnerNum, since: prof.marriedAt });
    }

    if (!couples.length) return sendText(sock, from, "[ (._.) ] No hay parejas casadas en este grupo kashira.", msg);

    couples.sort((x, y) => (x.since || 0) - (y.since || 0));
    const lines = couples.map((c, i) => `${i + 1}- *${c.a}* 💞 *${c.b}*${c.since ? ` (desde ${formatDateEs(c.since)})` : ""}`);
    await sendText(sock, from, `*⌞ Parejas del grupo ⌝*\n━━━━━━━━━━━━━━━━\n\n${lines.join("\n")}\n━━━━━━━━━━━━━━━━`, msg);
  }

  else if (finalCmd === "forcemarry" && isOwner(sender)) {
    const mentions = (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []).map(j => resolveToPN(j));
    const u1 = mentions[0];
    const u2 = mentions[1];
    if (!u1 || !u2) return sendText(sock, from, "[ x_x ] Usa: #forcemarry @usuario1 @usuario2 kashira.", msg);
    const n1 = u1.split("@")[0].split(":")[0];
    const n2 = u2.split("@")[0].split(":")[0];

    await sock.sendMessage(from, {
      text: `*⌞ (>////<) Matrimonio ⌝*\n━━━━━━━━━━━━━━━━\n\n[ (*>////<) ] ¡@${n1} y @${n2} ahora están casados kashira!\n\n(*^.^*) ¡Que sean muy felices!\n\n━━━━━━━━━━━━━━━━\n¡Kashira!`,
      mentions: [u1, u2]
    }, { quoted: msg });
  }

  else if (finalCmd === "divorce") {
    if (!db.profiles?.[senderNum]) return sendText(sock, from, "[ x_x ] Primero crea tu perfil con #createprofile kashira.", msg);
    if (!db.profiles[senderNum].partner) return sendText(sock, from, `[ x_x ] No estás ${genderWord(db.profiles[senderNum], "casado")} kashira.`, msg);
    const exNum = db.profiles[senderNum].partner;
    db.profiles[senderNum].partner = null;
    db.profiles[senderNum].marriedAt = null;
    if (db.profiles[exNum]) {
      db.profiles[exNum].partner = null;
      db.profiles[exNum].marriedAt = null;
    }
    saveDB(db);
    await sock.sendMessage(from, {
      text: `[ °﹏° ] Qué triste kashira @${senderNum}... el divorcio se ha completado.\n\n(._.) Espero que encuentres tu felicidad de nuevo kashira.`,
      mentions: [sender]
    }, { quoted: msg });
  }

  else if (finalCmd === "adoptpet") {
    if (!db.profiles?.[senderNum]) return sendText(sock, from, "[ x_x ] Primero crea tu perfil con #createprofile kashira.", msg);
    const prof = db.profiles[senderNum];

    const parts = rest.trim().split(/\s+/).filter(Boolean);
    const firstWord = normalizeText(parts[0] || "");

    if (!parts.length || firstWord === "lista" || firstWord === "list") {
      const typeFilter = parts[1] ? normalizeText(parts[1]) : null;
      const types = typeFilter && PET_TYPES.includes(typeFilter) ? [typeFilter] : PET_TYPES;
      const rarityShort = { comun: "C", raro: "R", epico: "E", legendario: "L" };
      const lines = types.map(t => {
        const mons = POKEMON_CATALOG.filter(p => p.type === t);
        const list = mons.map(m => `${m.name} (${rarityShort[m.rarity]})`).join(", ");
        return `${PET_TYPE_EMOJI[t]} *${PET_TYPE_LABEL[t]}:*\n${list}`;
      }).join("\n\n");

      return sendText(sock, from,
        `*⌞ Mascotas disponibles ⌝*\n━━━━━━━━━━━━━━━━\n\n${lines}\n\n` +
        `_C=Común (${fmtM(petPrice("comun"))}) · R=Raro (${fmtM(petPrice("raro"))}) · E=Épico (${fmtM(petPrice("epico"))}) · L=Legendario (${fmtM(petPrice("legendario"))})_\n\n` +
        `Usa: #adoptpet [especie] [nombre] kashira.\nEjemplo: #adoptpet charmander Luna\n` +
        `Filtra por tipo: #adoptpet lista fuego\n━━━━━━━━━━━━━━━━`, msg);
    }

    if (prof.pet) return sendText(sock, from, `[ (¬_¬) ] Ya tienes una mascota kashira (*${prof.pet.name}*). Usa #releasepet para darla en adopción antes de adoptar otra.`, msg);

    const speciesQuery = normalizeText(parts[0]);
    const mon = POKEMON_CATALOG.find(p => normalizeText(p.name) === speciesQuery);
    if (!mon) return sendText(sock, from, `[ x_x ] No encontré esa especie kashira. Usa #adoptpet lista para ver las 50 disponibles.`, msg);

    const name = parts.slice(1).join(" ").slice(0, 24);
    if (!name) return sendText(sock, from, "[ x_x ] Usa: #adoptpet [especie] [nombre] kashira.\n\nEjemplo: #adoptpet charmander Luna", msg);

    const eco = getEco(db, from, senderNum);
    const price = petPrice(mon.rarity);
    if (eco.bank < price) return sendText(sock, from, `[ x_x ] Te falta dinero en el banco de este grupo kashira. Necesitas ${fmtM(price)} (mascota ${PET_RARITY_LABEL[mon.rarity]}).`, msg);

    eco.bank -= price;
    prof.pet = {
      speciesId: mon.id,
      rarity: mon.rarity,
      name,
      level: 1,
      xp: 0,
      lastFed: Date.now(),
      lastPlayed: Date.now(),
    };
    saveDB(db);

    await sendText(sock, from, `[ (*^.^*) ] ¡Adoptaste a *${name}* (${mon.name}) kashira! Cuídalo con #feedpet y #playpet para no perder su bonificación.\n\n${formatPetCard(prof.pet)}`, msg);
  }

  else if (finalCmd === "pet") {
    const target = resolveMentionOrNick(db, msg, senderNum, rest);
    const targetNum = target ? findProfileNum(db, target) || target.split("@")[0].split(":")[0] : senderNum;
    const targetJid = target || sender;
    const isOwn = targetNum === senderNum;

    const prof = db.profiles?.[targetNum];
    if (!prof) return sendText(sock, from, `[ x_x ] ${isOwn ? "No tienes perfil kashira, usa #createprofile." : "Esa persona no tiene perfil kashira."}`, msg);
    if (!prof.pet) return sendText(sock, from, `[ x_x ] ${isOwn ? "No tienes mascota kashira, usa #adoptpet." : "Esa persona no tiene mascota kashira."}`, msg);

    await sock.sendMessage(from, {
      text: `*⌞ Mascota de ${prof.name} ⌝*\n━━━━━━━━━━━━━━━━\n\n${formatPetCard(prof.pet)}\n━━━━━━━━━━━━━━━━`,
      mentions: [targetJid]
    }, { quoted: msg });
  }

  else if (finalCmd === "releasepet") {
    if (!db.profiles?.[senderNum]) return sendText(sock, from, "[ x_x ] Primero crea tu perfil con #createprofile kashira.", msg);
    const prof = db.profiles[senderNum];
    if (!prof.pet) return sendText(sock, from, "[ x_x ] No tienes mascota kashira.", msg);
    const oldName = prof.pet.name;
    prof.pet = null;
    saveDB(db);
    await sendText(sock, from, `[ °﹏° ] Diste a *${oldName}* en adopción kashira. Ya puedes adoptar otra con #adoptpet.`, msg);
  }

  else if (finalCmd === "renamepet") {
    if (!db.profiles?.[senderNum]) return sendText(sock, from, "[ x_x ] Primero crea tu perfil con #createprofile kashira.", msg);
    const prof = db.profiles[senderNum];
    if (!prof.pet) return sendText(sock, from, "[ x_x ] No tienes mascota kashira.", msg);

    const newName = rest.trim().slice(0, 24);
    if (!newName) return sendText(sock, from, "[ x_x ] Usa: #renamepet [nombre nuevo] kashira.", msg);

    const oldName = prof.pet.name;
    prof.pet.name = newName;
    saveDB(db);
    await sendText(sock, from, `[ (*^.^*) ] Listo, *${oldName}* ahora se llama *${newName}* kashira.`, msg);
  }

  else if (finalCmd === "feedpet") {
    if (!db.profiles?.[senderNum]) return sendText(sock, from, "[ x_x ] Primero crea tu perfil con #createprofile kashira.", msg);
    const prof = db.profiles[senderNum];
    if (!prof.pet) return sendText(sock, from, "[ x_x ] No tienes mascota kashira, usa #adoptpet.", msg);

    const elapsed = Date.now() - (prof.pet.lastFed || 0);
    if (elapsed < PET_FEED_CD) {
      return sendText(sock, from, `[ (¬_¬) ] Espera *${fmtCooldown(PET_FEED_CD - elapsed)}* antes de volver a alimentar a *${prof.pet.name}* kashira.`, msg);
    }

    const gained = randInt(PET_FEED_XP[0], PET_FEED_XP[1]);
    const levelsUp = petAddXp(prof.pet, gained);
    prof.pet.lastFed = Date.now();
    saveDB(db);

    const { hunger } = getPetLiveStats(prof.pet);
    const levelUpTxt = levelsUp > 0 ? `\n\n(☆^ー^) ¡*${prof.pet.name}* subió a nivel *${prof.pet.level}*!` : "";
    await sendText(sock, from, `[ (^ω^) ] Alimentaste a *${prof.pet.name}* kashira, ahora tiene *${hunger}%* de hambre. (+${gained} XP)${levelUpTxt}`, msg);
  }

  else if (finalCmd === "playpet") {
    if (!db.profiles?.[senderNum]) return sendText(sock, from, "[ x_x ] Primero crea tu perfil con #createprofile kashira.", msg);
    const prof = db.profiles[senderNum];
    if (!prof.pet) return sendText(sock, from, "[ x_x ] No tienes mascota kashira, usa #adoptpet.", msg);

    const elapsed = Date.now() - (prof.pet.lastPlayed || 0);
    if (elapsed < PET_PLAY_CD) {
      return sendText(sock, from, `[ (¬_¬) ] Espera *${fmtCooldown(PET_PLAY_CD - elapsed)}* antes de volver a jugar con *${prof.pet.name}* kashira.`, msg);
    }

    const gained = randInt(PET_PLAY_XP[0], PET_PLAY_XP[1]);
    const levelsUp = petAddXp(prof.pet, gained);
    prof.pet.lastPlayed = Date.now();
    saveDB(db);

    const { happiness } = getPetLiveStats(prof.pet);
    const levelUpTxt = levelsUp > 0 ? `\n\n(☆^ー^) ¡*${prof.pet.name}* subió a nivel *${prof.pet.level}*!` : "";
    await sendText(sock, from, `[ (^ω^) ] Jugaste con *${prof.pet.name}* kashira, ahora tiene *${happiness}%* de felicidad. (+${gained} XP)${levelUpTxt}`, msg);
  }

  else if (finalCmd === "preg" || finalCmd === "pregnant") {
    if (!db.profiles?.[senderNum]) return sendText(sock, from, "[ x_x ] Primero crea tu perfil con #createprofile kashira.", msg);
    const prof = db.profiles[senderNum];

    if (!prof.partner) return sendText(sock, from, "[ x_x ] Tienes que estar casado kashira para tener hijos. Usa #marry primero.", msg);
    const partnerProf = db.profiles[prof.partner];
    if (!partnerProf) return sendText(sock, from, "[ x_x ] Tu pareja ya no tiene perfil kashira, algo se rompió por ahí °﹏°.", msg);

    prof.kids = Array.isArray(prof.kids) ? prof.kids : [];
    partnerProf.kids = Array.isArray(partnerProf.kids) ? partnerProf.kids : [];
    if (prof.kids.length >= KID_MAX) return sendText(sock, from, `[ x_x ] Ya tienen el máximo de ${KID_MAX} hijos kashira.`, msg);

    const elapsed = Date.now() - Math.max(prof.lastPreg || 0, partnerProf.lastPreg || 0);
    if (elapsed < KID_PREG_CD) {
      return sendText(sock, from, `[ (¬_¬) ] Espera *${fmtCooldown(KID_PREG_CD - elapsed)}* antes de intentarlo de nuevo kashira.`, msg);
    }

    const name = rest.trim().slice(0, 24);
    if (!name) return sendText(sock, from, "[ x_x ] Usa: #preg [nombre] kashira.\n\nEjemplo: #preg Sakura", msg);

    const bornAt = Date.now();
    // El hijo se guarda por separado en AMBOS perfiles (misma fecha de nacimiento y
    // nombre), pero la etapa de crecimiento se calcula siempre al vuelo desde bornAt,
    // así que nunca hay riesgo de que se desincronicen entre los dos padres.
    prof.kids.push({ name, bornAt });
    partnerProf.kids.push({ name, bornAt });
    prof.lastPreg = bornAt;
    partnerProf.lastPreg = bornAt;
    saveDB(db);

    const partnerJid = prof.partner + "@s.whatsapp.net";
    const caption = `*⌞ (◍•ᴗ•◍) ¡Felicidades! ⌝*\n━━━━━━━━━━━━━━━━\n\n¡@${senderNum} y @${prof.partner} le dieron la bienvenida a *${name}* kashira!\n\n(^w^) Empieza como Bebé, cuídalo bien.\n━━━━━━━━━━━━━━━━`;
    const pregVideoPath = "./preg.mp4";
    if (fs.existsSync(pregVideoPath)) {
      await sock.sendMessage(from, {
        video: fs.readFileSync(pregVideoPath),
        mimetype: "video/mp4",
        gifPlayback: true,
        caption,
        mentions: [sender, partnerJid]
      }, { quoted: msg });
    } else {
      await sock.sendMessage(from, { text: caption, mentions: [sender, partnerJid] }, { quoted: msg });
    }
  }

  else if (finalCmd === "renamekid") {
    if (!db.profiles?.[senderNum]) return sendText(sock, from, "[ x_x ] Primero crea tu perfil con #createprofile kashira.", msg);
    const prof = db.profiles[senderNum];
    const kids = prof.kids || [];
    if (!kids.length) return sendText(sock, from, "[ x_x ] No tienes hijos kashira.", msg);

    const parts = rest.trim().split(/\s+/).filter(Boolean);
    const idx = parseInt(parts[0], 10);
    const newName = parts.slice(1).join(" ").slice(0, 24);

    if (!idx || idx < 1 || idx > kids.length || !newName) {
      const list = kids.map((k, i) => `${i + 1}. ${k.name}`).join("\n");
      return sendText(sock, from, `[ x_x ] Usa: #renamekid [número] [nombre nuevo] kashira.\n\nTus hijos:\n${list}`, msg);
    }

    const kid = kids[idx - 1];
    const oldName = kid.name;
    const bornAt = kid.bornAt;
    kid.name = newName;

    // El hijo vive duplicado en el perfil de la pareja (mismo bornAt, para que la
    // etapa de crecimiento nunca se desincronice) — hay que renombrarlo ahí también.
    if (prof.partner && db.profiles[prof.partner]) {
      const partnerKid = (db.profiles[prof.partner].kids || []).find(k => k.bornAt === bornAt && k.name === oldName);
      if (partnerKid) partnerKid.name = newName;
    }
    saveDB(db);

    await sendText(sock, from, `[ (*^.^*) ] Listo, *${oldName}* ahora se llama *${newName}* kashira.`, msg);
  }

  else if (finalCmd === "pvsp" || finalCmd === "petvspet") {
    if (!db.profiles?.[senderNum]) return sendText(sock, from, "[ x_x ] Primero crea tu perfil con #createprofile kashira.", msg);
    const prof = db.profiles[senderNum];
    if (!prof.pet) return sendText(sock, from, "[ x_x ] No tienes mascota kashira, usa #adoptpet.", msg);

    const target = resolveMentionOrNick(db, msg, senderNum, rest);
    const targetNum = target ? findProfileNum(db, target) || target.split("@")[0].split(":")[0] : null;
    if (!target || !targetNum) return sendText(sock, from, `[ x_x ] Usa: #pvsp @contrincante [apuesta] kashira. Mínimo ${fmtM(ECO.BET_MIN)}.`, msg);
    if (targetNum === senderNum) return sendText(sock, from, "[ x_x ] No puedes retarte a ti mismo/a kashira °﹏°.", msg);

    const targetProf = db.profiles[targetNum];
    if (!targetProf) return sendText(sock, from, "[ x_x ] Esa persona no tiene perfil kashira.", msg);
    if (!targetProf.pet) return sendText(sock, from, "[ x_x ] Esa persona no tiene mascota kashira.", msg);

    const cleanRest = stripMentionText(msg, rest);
    const amtMatch = cleanRest.match(/\d+/);
    const amount = amtMatch ? parseInt(amtMatch[0], 10) : NaN;
    if (!amount || amount < ECO.BET_MIN) return sendText(sock, from, `[ x_x ] Usa: #pvsp @contrincante [apuesta] kashira. Mínimo ${fmtM(ECO.BET_MIN)}.`, msg);

    const levelDiff = Math.abs((prof.pet.level || 1) - (targetProf.pet.level || 1));
    if (levelDiff > PET_LEVEL_CHALLENGE_RANGE) {
      return sendText(sock, from, `[ x_x ] Solo puedes retar mascotas dentro de ±${PET_LEVEL_CHALLENGE_RANGE} niveles kashira (*${targetProf.pet.name}* es nivel ${targetProf.pet.level}, la tuya es nivel ${prof.pet.level}).`, msg);
    }

    const eco = getEco(db, from, senderNum);
    if (amount > eco.wallet) return sendText(sock, from, "[ x_x ] No tienes esa cantidad fuera del banco kashira.", msg);

    const cdElapsed = Date.now() - (prof.lastPvspBattle || 0);
    if (cdElapsed < PVSP_CD) return sendText(sock, from, `[ (¬_¬) ] Espera *${fmtCooldown(PVSP_CD - cdElapsed)}* antes de retar de nuevo kashira.`, msg);

    targetProf.pendingVs = { from: senderNum, amount, ts: Date.now() };
    saveDB(db);

    await sock.sendMessage(from, {
      text: `*⌞ Reto de mascotas ⌝*\n━━━━━━━━━━━━━━━━\n\n@${targetNum}, ¡@${senderNum} te reta a una pelea kashira!\n\n(o^-')b *${prof.pet.name}* (Nv.${prof.pet.level}) vs *${targetProf.pet.name}* (Nv.${targetProf.pet.level})\nApuesta: *${fmtM(amount)}*\n\nPara aceptar responde:\n*#acceptvs @${senderNum}*\n━━━━━━━━━━━━━━━━`,
      mentions: [sender, target]
    }, { quoted: msg });
  }

  else if (finalCmd === "acceptvs") {
    if (!db.profiles?.[senderNum]) return sendText(sock, from, "[ x_x ] Primero crea tu perfil con #createprofile kashira.", msg);
    const prof = db.profiles[senderNum];
    if (!prof.pet) return sendText(sock, from, "[ x_x ] No tienes mascota kashira, usa #adoptpet.", msg);

    const target = resolveMentionOrNick(db, msg, senderNum, rest);
    const targetNum = target ? findProfileNum(db, target) || target.split("@")[0].split(":")[0] : null;
    if (!target || !targetNum) return sendText(sock, from, "[ x_x ] Menciona a quien te retó kashira.\n\nUsa: #acceptvs @contrincante", msg);

    if (!prof.pendingVs || prof.pendingVs.from !== targetNum) {
      return sendText(sock, from, "[ x_x ] Esa persona no te ha retado kashira.", msg);
    }

    const challengerProf = db.profiles[targetNum];
    if (!challengerProf || !challengerProf.pet) {
      prof.pendingVs = null;
      saveDB(db);
      return sendText(sock, from, "[ x_x ] Quien te retó ya no tiene perfil o mascota kashira, se canceló el reto.", msg);
    }

    const { amount } = prof.pendingVs;

    // Se revalida el rango de nivel y el dinero con el estado ACTUAL de ambos (pudieron
    // haber cambiado desde que se lanzó el reto: subieron de nivel, gastaron dinero, etc).
    const levelDiff = Math.abs((prof.pet.level || 1) - (challengerProf.pet.level || 1));
    if (levelDiff > PET_LEVEL_CHALLENGE_RANGE) {
      prof.pendingVs = null;
      saveDB(db);
      return sendText(sock, from, `[ x_x ] Ya no pueden pelear kashira, la diferencia de nivel superó ±${PET_LEVEL_CHALLENGE_RANGE}. Se canceló el reto.`, msg);
    }

    const myEco = getEco(db, from, senderNum);
    const challengerEco = getEco(db, from, targetNum);
    if (amount > myEco.wallet) return sendText(sock, from, "[ x_x ] No tienes esa cantidad fuera del banco kashira.", msg);
    if (amount > challengerEco.wallet) {
      prof.pendingVs = null;
      saveDB(db);
      return sendText(sock, from, "[ x_x ] Quien te retó ya no tiene esa cantidad kashira, se canceló el reto.", msg);
    }

    const cdElapsedMe = Date.now() - (prof.lastPvspBattle || 0);
    if (cdElapsedMe < PVSP_CD) return sendText(sock, from, `[ (¬_¬) ] Espera *${fmtCooldown(PVSP_CD - cdElapsedMe)}* antes de pelear de nuevo kashira.`, msg);
    const cdElapsedChallenger = Date.now() - (challengerProf.lastPvspBattle || 0);
    if (cdElapsedChallenger < PVSP_CD) {
      return sendText(sock, from, `[ x_x ] @${targetNum} todavía está en cooldown de su última pelea kashira, espera un poco.`, msg);
    }

    // Probabilidad de que GANE quien acepta (senderNum), según tipo + nivel de ambas mascotas.
    // Si alguno de los dos tiene jinx activo en este grupo, se le fuerza la derrota
    // (si por alguna razón AMBOS estuvieran jinxeados a la vez, gana quien acepta,
    // simplemente para tener una regla de desempate determinista).
    const accepterJinxed = consumeJinx(db, from, senderNum);
    const challengerJinxed = consumeJinx(db, from, targetNum);
    const winChance = goodChanceWithLuck(db, from, senderNum, computePvspWinChance(prof.pet, challengerProf.pet));
    const accepterWins = challengerJinxed ? true : (accepterJinxed ? false : Math.random() < winChance);

    const winnerNum = accepterWins ? senderNum : targetNum;
    const loserNum = accepterWins ? targetNum : senderNum;
    const winnerEco = accepterWins ? myEco : challengerEco;
    const loserEco = accepterWins ? challengerEco : myEco;
    const winnerPet = accepterWins ? prof.pet : challengerProf.pet;
    const loserPet = accepterWins ? challengerProf.pet : prof.pet;

    winnerEco.wallet += amount;
    loserEco.wallet -= amount;

    const winXp = randInt(PVSP_WIN_XP[0], PVSP_WIN_XP[1]);
    const loseXp = randInt(PVSP_LOSE_XP[0], PVSP_LOSE_XP[1]);
    const winnerLevelsUp = petAddXp(winnerPet, winXp);
    const loserLevelsUp = petAddXp(loserPet, loseXp);

    const now = Date.now();
    prof.lastPvspBattle = now;
    challengerProf.lastPvspBattle = now;
    prof.pendingVs = null;
    saveDB(db);

    const winnerJid = winnerNum + "@s.whatsapp.net";
    const loserJid = loserNum + "@s.whatsapp.net";
    const levelUpTxt =
      (winnerLevelsUp > 0 ? `\n(☆^ー^) ¡*${winnerPet.name}* subió a nivel *${winnerPet.level}*!` : "") +
      (loserLevelsUp > 0 ? `\n(☆^ー^) ¡*${loserPet.name}* subió a nivel *${loserPet.level}*!` : "");

    await sock.sendMessage(from, {
      text: `*⌞ Resultado de la pelea ⌝*\n━━━━━━━━━━━━━━━━\n\n(o^-')b *${winnerPet.name}* le ganó a *${loserPet.name}* kashira!\n\n@${winnerNum} gana *${fmtM(amount)}* (+${winXp} XP)\n@${loserNum} pierde *${fmtM(amount)}* (+${loseXp} XP)${levelUpTxt}\n━━━━━━━━━━━━━━━━`,
      mentions: [winnerJid, loserJid]
    }, { quoted: msg });
  }

  else if (finalCmd === "level") {
    const target = resolveMentionOrNick(db, msg, senderNum, rest);
    const targetNum = target ? findProfileNum(db, target) || target.split("@")[0].split(":")[0] : senderNum;
    const targetJid = target || sender;
    const isOwn = targetNum === senderNum;

    const prof = db.profiles?.[targetNum];
    if (!prof) {
      return await sock.sendMessage(from, {
        text: `[ x_x ] ${isOwn ? `@${senderNum} no tienes perfil kashira` : `@${targetNum} no tiene perfil kashira`}. ${isOwn ? "Crea uno con #createprofile kashira (^w^)" : ""}`,
        mentions: [targetJid]
      }, { quoted: msg });
    }

    if (typeof prof.level !== "number") prof.level = 1;
    if (typeof prof.xp !== "number") prof.xp = 0;
    const needed = xpForLevel(prof.level);
    const pct = Math.floor((prof.xp / needed) * 100);

    await sock.sendMessage(from, {
      text: `*⌞ Nivel de ${prof.name} ⌝*\n━━━━━━━━━━━━━━━━\n\n(☆^ー^) *Nivel:* ${prof.level}\n(o^-')b *XP:* ${prof.xp} / ${needed} (${pct}%)\n\n_Gana XP mandando mensajes y usando comandos kashira._\n━━━━━━━━━━━━━━━━`,
      mentions: [targetJid]
    }, { quoted: msg });
  }

  else if (finalCmd === "profile") {
    const target = resolveMentionOrNick(db, msg, senderNum, rest);
    const targetNum = target ? findProfileNum(db, target) || target.split("@")[0].split(":")[0] : senderNum;
    const targetJid = target || sender;
    const isOwn = targetNum === senderNum;

    const prof = db.profiles?.[targetNum];
    if (!prof) {
      return await sock.sendMessage(from, {
        text: `[ x_x ] ${isOwn ? `@${senderNum} no tienes perfil kashira` : `@${targetNum} no tiene perfil kashira`}. ${isOwn ? "Crea uno con #createprofile kashira (^w^)" : ""}`,
        mentions: [targetJid]
      }, { quoted: msg });
    }

    if (!isOwn && prof.privacy === "private") {
      return await sock.sendMessage(from, {
        text: `[ (¬_¬) ] El perfil de @${targetNum} es privado kashira.`,
        mentions: [target]
      }, { quoted: msg });
    }

    let partnerInfo = `(._.) ${genderWord(prof, "Soltero")} kashira`;
    const mentionsList = [targetJid];
    if (prof.partner) {
      const partnerProf = db.profiles[prof.partner];
      const partnerName = partnerProf?.name || prof.partner;
      const marriedDays = prof.marriedAt ? Math.max(0, Math.floor((Date.now() - prof.marriedAt) / (24 * 60 * 60 * 1000))) : null;
      const marriedDaysTxt = marriedDays === null ? "" : ` — hace ${marriedDays} ${marriedDays === 1 ? "día" : "días"}`;
      partnerInfo = `(*>////<) ${genderWord(prof, "Casado")} con *${partnerName}*${marriedDaysTxt}`;
    }

    // Hijos: la etapa se calcula siempre al vuelo desde bornAt, nunca se guarda a mano
    // (así nunca queda desincronizada entre los 2 perfiles de los padres).
    const kids = Array.isArray(prof.kids) ? prof.kids : [];
    const kidsBlock = kids.length
      ? `\n──────────────\n(⁠｡⁠•⁠ᴗ⁠•⁠｡⁠) *Hijos:*\n${kids.map(k => {
          const st = getKidStage(k.bornAt);
          return ` |> ${k.name || "Sin nombre"} — ${st.label} (${st.ageDays}d)`;
        }).join("\n")}\n`
      : "";

    // Mascota: solo nombre/nivel/xp aquí (la tarjeta completa con especie/rareza/tipo/
    // bonificación vive en #pet, para no saturar el perfil).
    let petLine = "_Sin mascota kashira, usa #adoptpet_";
    if (prof.pet) {
      const needed = petXpForLevel(prof.pet.level || 1);
      petLine = `${prof.pet.name || "Sin nombre"} Nv.${prof.pet.level || 1} (${prof.pet.xp || 0}/${needed} XP)`;
    }
    const petBlock = `\n──────────────\nPet: ${petLine}\n`;

    const inv = db.inventory?.[targetNum] || null;
    const equippedTitleTxt = inv?.equippedTitle ? titleName(db, inv.equippedTitle) : null;
    const titleLine = equippedTitleTxt ? `*${equippedTitleTxt}*` : "_Sin título equipado kashira_";

    // Objetos: NUNCA se muestra el nombre explícito, solo la frase de perfil de cada uno.
    const equippedItemsList = inv?.equippedItems?.length
      ? inv.equippedItems.map(id => ` > ${itemProfilePhrase(id)}`).join("\n")
      : "";
    const equippedItemsBlock = equippedItemsList
      ? `\n──────────────\n(p^.^q) *Objetos equipados:*\n${equippedItemsList}\n`
      : "";

    const favs = prof.favorites || {};
    const favKeys = Object.keys(favs);
    const favoritesBlock = favKeys.length
      ? `\n──────────────\n(o^.^o) *Favoritos:*\n${favKeys.map(k => ` > *${k}:* ${favs[k]}`).join("\n")}\n`
      : "";

    const text =
      `*⌞ Perfil de ${prof.name} ⌝*\n` +
      `━━━━━━━━━━━━━━━━\n\n` +
      `(o^-')b *Nombre:* ${prof.name}\n` +
      `(☆^ー^) *Título:* ${titleLine}\n` +
      `(^w^) *Nacimiento:* ${prof.birth || "No especificado"}\n` +
      `${partnerInfo}\n` +
      kidsBlock +
      petBlock +
      `\n` +
      `──────────────\n` +
      `(¬_¬) *Descripción:*\n_${prof.desc || "Sin descripción kashira"}_\n` +
      equippedItemsBlock +
      favoritesBlock +
      `━━━━━━━━━━━━━━━━\n` +
      `¡Kashira!`;

    try {
      if (prof.pfp && /^https?:\/\//.test(prof.pfp)) {
        // Foto de perfil nueva: URL externa (catbox.moe), no ocupa disco local.
        await sock.sendMessage(from, {
          image: { url: prof.pfp },
          caption: text,
          mentions: mentionsList
        }, { quoted: msg });
      } else if (prof.pfp && fs.existsSync(prof.pfp)) {
        // Compatibilidad con fotos de perfil viejas que se habían guardado localmente
        // antes de este cambio.
        await sock.sendMessage(from, {
          image: fs.readFileSync(prof.pfp),
          caption: text,
          mentions: mentionsList
        }, { quoted: msg });
      } else {
        const waUrl = await Promise.race([
          sock.profilePictureUrl(targetJid, "image").catch(() => null),
          new Promise(r => setTimeout(() => r(null), 3000))
        ]);
        if (waUrl) {
          await sock.sendMessage(from, {
            image: { url: waUrl },
            caption: text,
            mentions: mentionsList
          }, { quoted: msg });
        } else {
          await sock.sendMessage(from, { text, mentions: mentionsList }, { quoted: msg });
        }
      }
    } catch (e) {
      await sock.sendMessage(from, { text, mentions: mentionsList }, { quoted: msg });
    }
  }

  else if (finalCmd === "stats") {
    const target = resolveMentionOrNick(db, msg, senderNum, rest);
    const targetNum = target ? findProfileNum(db, target) || target.split("@")[0].split(":")[0] : senderNum;
    const targetJid = target || sender;
    const isOwn = targetNum === senderNum;

    const prof = db.profiles?.[targetNum];
    if (!prof) {
      return await sock.sendMessage(from, {
        text: `[ x_x ] ${isOwn ? `@${senderNum} no tienes perfil kashira` : `@${targetNum} no tiene perfil kashira`}. ${isOwn ? "Crea uno con #createprofile kashira (^w^)" : ""}`,
        mentions: [targetJid]
      }, { quoted: msg });
    }

    if (!isOwn && prof.privacy === "private") {
      return await sock.sendMessage(from, {
        text: `[ (¬_¬) ] El perfil de @${targetNum} es privado kashira.`,
        mentions: [target]
      }, { quoted: msg });
    }

    const gStats = isGroup ? (prof.groupStats?.[from] || { msgs: 0, cmds: 0 }) : null;
    const eco = isGroup ? db.economy?.[from]?.[targetNum] : null;
    const warnsCount = isGroup ? (db.warns?.[from]?.[targetNum]?.length || 0) : 0;
    const inv = db.inventory?.[targetNum] || null;
    const titlesCount = inv?.titles?.length || 0;
    const itemsCount = inv?.items?.length || 0;

    // Puesto en el ranking de mensajes del grupo actual
    let rankLine = "";
    if (isGroup) {
      const meta = await sock.groupMetadata(from).catch(() => null);
      if (meta) {
        updateLidMapFromMeta(meta);
        const nums = [...new Set(meta.participants.map(p => resolveToPN(p.id).split("@")[0].split(":")[0]))];
        const ranked = nums
          .filter(n => db.profiles?.[n]?.groupStats?.[from]?.msgs)
          .map(n => ({ num: n, msgs: db.profiles[n].groupStats[from].msgs }))
          .sort((a, b) => b.msgs - a.msgs);
        const pos = ranked.findIndex(e => e.num === targetNum);
        if (pos !== -1) rankLine = `  (☆^ー^) Puesto en el grupo: *#${pos + 1} de ${ranked.length}*\n`;
      }
    }

    const text =
      `*⌞ Estadísticas de ${prof.name} ⌝*\n` +
      `━━━━━━━━━━━━━━━━\n\n` +
      `(*°▽°*) *General:*\n` +
      `  (o^-')b Comandos totales usados: *${prof.stats?.totalCmds || 0}*\n` +
      `  (^w^) Miembro desde: *${formatDateEs(prof.createdAt)}*\n` +
      `  (☆^ー^) Títulos obtenidos: *${titlesCount}*\n` +
      `  (>////<) Objetos obtenidos: *${itemsCount}*\n` +
      (isGroup
        ? `\n(*^.^*) *En este grupo:*\n` +
          `  (p^.^q) Mensajes: *${gStats.msgs}*\n` +
          `  (o^-')b Comandos: *${gStats.cmds}*\n` +
          rankLine +
          (eco ? `  ($_$) Saldo (billetera + banco): *$${(eco.wallet || 0) + (eco.bank || 0)}*\n` : "") +
          `  (¬_¬) Advertencias: *${warnsCount}*\n`
        : `\n_Usa este comando dentro de un grupo para ver mensajes, comandos, saldo, ranking y advertencias kashira._\n`) +
      `━━━━━━━━━━━━━━━━\n` +
      `¡Kashira!`;

    await sock.sendMessage(from, { text, mentions: [targetJid] }, { quoted: msg });
  }

  else if (finalCmd === "warn") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo administradores pueden usar #warn.", msg);

    const target = resolveToPN(getMentionedJid(msg));
    if (!target) return sendText(sock, from, "[ x_x ] Debes mencionar o responder a alguien kashira.", msg);

    // Quitamos la mención sin importar en qué parte del texto esté, para quedarnos solo
    // con el motivo (así funciona "#warn @user motivo" y "#warn motivo @user" por igual).
    const targetNum = target.split("@")[0];
    const motivo = stripMentionText(msg, rest);

    if (!motivo) return sendText(sock, from, "[ x_x ] Debes especificar un motivo.\n\nUsa: #warn @usuario <motivo>  o  #warn <motivo> @usuario", msg);

    db.warns = db.warns || {};
    db.warns[from] = db.warns[from] || {};
    db.warns[from][target] = db.warns[from][target] || [];

    db.warns[from][target].push({
      motivo,
      fecha: new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" }),
      por: sender,
      porNum: sender.split("@")[0],
    });
    saveDB(db);

    const totalWarns = db.warns[from][target].length;
    const warnLimit = getWarnLimit(db, from);
    const beatriceWarnMsg = getBeatriceWarnMsg(totalWarns, warnLimit);

    await sock.sendMessage(from, {
      text: `[ Σ(°△°|||) ] @${targetNum} ha recibido una advertencia kashira.\n\n*Motivo:* ${motivo}\n\n*Advertencias:* ${totalWarns}/${warnLimit}\n\n${beatriceWarnMsg}`,
      mentions: [target]
    }, { quoted: msg });

    if (totalWarns >= warnLimit) {
      const list = db.warns[from][target]
        .map((w, i) => `${i + 1}. *${w.fecha}*\n   Motivo: ${w.motivo}\n   Por: ${w.por ? "@" + w.porNum : w.porNum}`)
        .join("\n\n");

      await sock.sendMessage(from, {
        text: `[ (╬ Ò﹏Ó) ] @${targetNum} llegó a *${totalWarns} advertencia${totalWarns > 1 ? "s" : ""}* kashira!\n\n${list}\n\n${beatriceWarnMsg}`,
        mentions: [target, ...db.warns[from][target].map(w => w.por).filter(Boolean)]
      }, { quoted: msg });
      await applyWarnLimitAction(sock, from, target, targetNum);
    }
  }

  else if (finalCmd === "seew") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);

    const target = resolveMentionOrNick(db, msg, senderNum, rest) || sender;
    const targetNum = target.split("@")[0];
    const warns = db.warns?.[from]?.[target] || [];

    if (warns.length === 0) {
      return await sock.sendMessage(from, {
        text: `[ (o^.^o) ] @${targetNum} no tiene advertencias kashira.`,
        mentions: [target]
      }, { quoted: msg });
    }

    const beatriceWarnMsg = getBeatriceWarnMsg(warns.length, getWarnLimit(db, from));

    const list = warns
      .map((w, i) => `${i + 1}. *${w.fecha}*\n   Motivo: ${w.motivo}\n   Por: ${w.por ? "@" + w.porNum : w.porNum}`)
      .join("\n\n");

    await sock.sendMessage(from, {
      text: `*⌞ Advertencias de @${targetNum} ⌝*\n\n${list}\n\n*Total:* ${warns.length}/${getWarnLimit(db, from)}\n\n${beatriceWarnMsg}`,
      mentions: [target, ...warns.map(w => w.por).filter(Boolean)]
    }, { quoted: msg });
  }

  else if (finalCmd === "delwarn") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo administradores pueden usar #delwarn.", msg);

    const target = resolveToPN(getMentionedJid(msg));
    if (!target) return sendText(sock, from, "[ x_x ] Debes mencionar o responder a alguien kashira.", msg);

    // Quitamos la mención sin importar en qué parte del texto esté, para quedarnos solo
    // con el número de warn (así funciona "#delwarn @user N" y "#delwarn N @user" por igual).
    const targetNum = target.split("@")[0];
    const argText = stripMentionText(msg, rest);
    const warnIndexMatch = argText.match(/\d+/);
    const warnIndex = warnIndexMatch ? parseInt(warnIndexMatch[0], 10) : NaN;

    if (isNaN(warnIndex) || warnIndex < 1) {
      return sendText(sock, from, "[ x_x ] Usa: #delwarn @usuario <número de warn>  o  #delwarn <número de warn> @usuario\n\nEjemplo: #delwarn @usuario 2", msg);
    }

    const warns = db.warns?.[from]?.[target] || [];
    if (warns.length === 0) {
      return sock.sendMessage(from, { text: `[ x_x ] @${targetNum} no tiene advertencias kashira.`, mentions: [target] }, { quoted: msg });
    }
    if (warnIndex > warns.length) {
      return sock.sendMessage(from, { text: `[ x_x ] @${targetNum} solo tiene ${warns.length} advertencia(s) kashira.`, mentions: [target] }, { quoted: msg });
    }

    const removed = warns.splice(warnIndex - 1, 1)[0];
    saveDB(db);

    await sock.sendMessage(from, {
      text: `[ (•̀ᴗ•́)و ] Advertencia #${warnIndex} eliminada de @${targetNum} kashira.\n\n*Motivo eliminado:* ${removed.motivo}\n*Advertencias restantes:* ${warns.length}/${getWarnLimit(db, from)}`,
      mentions: [target]
    }, { quoted: msg });
  }

  else if (finalCmd === "warnlimit") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo administradores pueden usar #warnlimit.", msg);

    const arg = normalizeText(rest.trim());
    if (!arg) {
      return sendText(sock, from, `[ x_x ] Usa: #warnlimit [número]  o  #warnlimit off kashira.\n\nLímite actual en este grupo: *${getWarnLimit(db, from)}* advertencias.`, msg);
    }
    if (["off", "reset", "normal"].includes(arg)) {
      if (db.warnLimits) delete db.warnLimits[from];
      saveDB(db);
      return sendText(sock, from, "[ (¬‿¬) ] Límite de advertencias reseteado a *5* (el default) kashira.", msg);
    }
    const n = parseInt(rest.trim(), 10);
    if (isNaN(n) || n < 1 || n > 50) return sendText(sock, from, "[ x_x ] Usa: #warnlimit [número entre 1 y 50]  o  #warnlimit off kashira.", msg);

    db.warnLimits = db.warnLimits || {};
    db.warnLimits[from] = n;
    saveDB(db);
    await sendText(sock, from, `[ (¬‿¬) ] Listo kashira, ahora se necesitan *${n}* advertencias para el aviso de límite en este grupo.`, msg);
  }

  // ══════════════════════════════
  //    MODERACIÓN: #ON / #OFF (BOT, CHAT, WEL, BYE, BIRTHDAY, ANTILINK, CATEGORÍAS)
  // ══════════════════════════════

  else if (finalCmd === "on" || finalCmd === "off") {
    const isOn = finalCmd === "on";
    const target = normalizeText(rest);

    if (!target) {
      return sendText(sock, from, `[ x_x ] Usa: #${finalCmd} <opción>\n\nOpciones: bot, chat, wel, bye, birthday, antilink, antiaudio, antisticker, antiimage, antivideo, antispam, antibot, onlyadmins\nCategorías: ${VALID_CATEGORIES.map(c => `▸ ${c}`).join("\n")}`, msg);
    }

    // ── bot: enciende/apaga al bot en este chat (solo owner) ──
    if (target === "bot") {
      if (!isOwnerLevel(db, sender)) return sendText(sock, from, "[ x_x ] Solo el owner.", msg);
      db.offGroups = db.offGroups || {};
      const currentlyOn = !db.offGroups[from];
      if (currentlyOn === isOn) {
        return sendText(sock, from, isOn ? "[ (¬_¬) ] El bot ya estaba encendido aquí kashira." : "[ (¬_¬) ] El bot ya estaba apagado aquí kashira.", msg);
      }
      if (isOn) delete db.offGroups[from];
      else db.offGroups[from] = true;
      saveDB(db);
      return sendText(sock, from, isOn ? "[ (o^-')b ] Bot encendido en este canal." : "[ (x_x) ] Bot apagado aquí.", msg);
    }

    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo administradores pueden usar esto.", msg);

    // ── chat: cierra/abre el grupo para que solo hablen admins ──
    if (target === "chat") {
      try {
        const meta = await sock.groupMetadata(from);
        const currentlyOpen = !meta.announce;
        if (currentlyOpen === isOn) {
          return sendText(sock, from, isOn ? "[ (¬_¬) ] El grupo ya estaba abierto kashira." : "[ (¬_¬) ] El grupo ya estaba cerrado kashira.", msg);
        }
        await sock.groupSettingUpdate(from, isOn ? "not_announcement" : "announcement");
        await sendText(sock, from, isOn
          ? "[ (*^.^*) ] Grupo abierto kashira, todos pueden hablar de nuevo."
          : "[ (¬_¬) ] Grupo cerrado kashira, solo los admins pueden hablar.", msg);
      } catch (e) {
        await sendText(sock, from, `[ ;﹏; ] No pude cambiar la configuración: ${e.message}. Revisa que Beatrice sea admin del grupo.`, msg);
      }
      return;
    }

    // ── wel / bye / birthday: prende o apaga los mensajes automáticos ──
    if (target === "wel" || target === "bye" || target === "birthday") {
      const dbKey = target === "wel" ? "welcomeEnabled" : target === "bye" ? "byeEnabled" : "birthdayEnabled";
      const label = target === "wel" ? "Bienvenidas" : target === "bye" ? "Despedidas" : "Cumpleaños";
      const emoji = target === "wel" ? "[ (*^.^*) ]" : target === "bye" ? "[ (._.)ﾉ ]" : "[ (๑˃ᴗ˂)ﻭ ]";
      db[dbKey] = db[dbKey] || {};
      if (!!db[dbKey][from] === isOn) {
        return sendText(sock, from, `[ (¬_¬) ] ${label} ya estaba *${isOn ? "ON" : "OFF"}* kashira.`, msg);
      }
      db[dbKey][from] = isOn;
      saveDB(db);
      return sendText(sock, from, `${emoji} ${label}: *${isOn ? "ON" : "OFF"}*`, msg);
    }

    // ── antilink: borra automático los links de invitación de otros grupos ──
    if (target === "antilink") {
      db.antilink = db.antilink || {};
      if (!!db.antilink[from] === isOn) {
        return sendText(sock, from, `[ (¬_¬) ] Antilink ya estaba *${isOn ? "ON" : "OFF"}* kashira.`, msg);
      }
      db.antilink[from] = isOn;
      saveDB(db);
      return sendText(sock, from, `[ (¬_¬) ] Antilink: *${isOn ? "ON" : "OFF"}*${isOn ? "\n\n_Se borrarán automáticamente los links de invitación de otros grupos y se dará una advertencia (excepto a admins). Beatrice necesita ser admin para poder borrarlos._" : ""}`, msg);
    }

    // ── anti-X (y onlyadmins): interruptores genéricos guardados por dbKey en la DB ──
    if (ANTI_TOGGLES[target]) {
      const info = ANTI_TOGGLES[target];
      db[info.dbKey] = db[info.dbKey] || {};
      if (!!db[info.dbKey][from] === isOn) {
        return sendText(sock, from, `[ (¬_¬) ] ${info.label} ya estaba *${isOn ? "ON" : "OFF"}* kashira.`, msg);
      }
      db[info.dbKey][from] = isOn;
      saveDB(db);
      return sendText(sock, from, `[ (¬_¬) ] ${info.label}: *${isOn ? "ON" : "OFF"}*${isOn ? `\n\n_${info.desc}_` : ""}`, msg);
    }

    // ── categorías: prende o apaga una categoría completa de comandos ──
    if (VALID_CATEGORIES.includes(target)) {
      db.disabledCategories = db.disabledCategories || {};
      db.disabledCategories[from] = db.disabledCategories[from] || [];
      const currentlyDisabled = db.disabledCategories[from].includes(target);
      if (isOn) {
        if (!currentlyDisabled) {
          return sendText(sock, from, `[ (¬_¬) ] La categoría *${target}* ya estaba activada kashira.`, msg);
        }
        db.disabledCategories[from] = db.disabledCategories[from].filter(c => c !== target);
        saveDB(db);
        return sendText(sock, from, `[ (*^.^*) ] Categoría *${target}* activada en este grupo kashira.`, msg);
      } else {
        if (currentlyDisabled) {
          return sendText(sock, from, `[ (¬_¬) ] La categoría *${target}* ya estaba desactivada kashira.`, msg);
        }
        db.disabledCategories[from].push(target);
        saveDB(db);
        return sendText(sock, from, `[ (¬_¬) ] Categoría *${target}* desactivada en este grupo kashira.`, msg);
      }
    }

    return sendText(sock, from, `[ x_x ] No reconozco *${target}* kashira.\n\nOpciones: bot, chat, wel, bye, birthday, antilink, antiaudio, antisticker, antiimage, antivideo, antispam, antibot, onlyadmins\nCategorías: ${VALID_CATEGORIES.map(c => `▸ ${c}`).join("\n")}`, msg);
  }

  else if (finalCmd === "toggles") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);

    const onOff = (v) => (v ? "(^ω^) ON" : "(x_x) OFF");

    let chatState = "—";
    try {
      const meta = await sock.groupMetadata(from);
      chatState = onOff(!meta.announce);
    } catch (e) {
      chatState = "(no se pudo consultar)";
    }

    const lines = [
      `*⌞ Interruptores de este grupo ⌝*`,
      `━━━━━━━━━━━━━━━━`,
      `Bot: ${onOff(!db.offGroups?.[from])}`,
      `Chat abierto: ${chatState}`,
      `Bienvenidas: ${onOff(!!db.welcomeEnabled?.[from])}`,
      `Despedidas: ${onOff(!!db.byeEnabled?.[from])}`,
      `Cumpleaños: ${onOff(!!db.birthdayEnabled?.[from])}`,
      `Antilink: ${onOff(!!db.antilink?.[from])}`,
      ...Object.entries(ANTI_TOGGLES).map(([key, info]) => `${info.label}: ${onOff(!!db[info.dbKey]?.[from])}`),
      `━━━━━━━━━━━━━━━━`,
      `*Categorías desactivadas:* ${db.disabledCategories?.[from]?.length ? db.disabledCategories[from].join(", ") : "ninguna"}`,
      `*Comandos bloqueados (#lock):* ${db.lockedCommands?.[from]?.length ? db.lockedCommands[from].map(c => `#${c}`).join(", ") : "ninguno"}`,
    ];

    return sendText(sock, from, lines.join("\n"), msg);
  }

  else if (finalCmd === "globaloff" || finalCmd === "globalon") {
    if (!isOwnerLevel(db, sender)) return sendText(sock, from, "[ x_x ] Solo el owner.", msg);
    const isOn = finalCmd === "globalon";

    let groups;
    try {
      groups = await sock.groupFetchAllParticipating();
    } catch (e) {
      return sendText(sock, from, `[ ;﹏; ] No pude obtener la lista de grupos: ${e.message}`, msg);
    }
    const gids = Object.keys(groups || {});
    if (!gids.length) return sendText(sock, from, "[ (._.) ] No estoy en ningún grupo kashira.", msg);

    db.offGroups = db.offGroups || {};
    for (const gid of gids) {
      if (isOn) delete db.offGroups[gid];
      else db.offGroups[gid] = true;
    }
    saveDB(db);

    await sendText(sock, from, isOn
      ? `[ (o^-')b ] Bot encendido en los *${gids.length}* grupos donde estoy kashira.`
      : `[ (x_x) ] Bot apagado en los *${gids.length}* grupos donde estoy kashira.`, msg);
  }

  else if (finalCmd === "gm") {
    if (!isOwner(sender)) return sendText(sock, from, "[ x_x ] Solo el owner original puede usar este comando kashira.", msg);
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #gm [mensaje] kashira.", msg);

    let groups;
    try {
      groups = await sock.groupFetchAllParticipating();
    } catch (e) {
      return sendText(sock, from, `[ ;﹏; ] No pude obtener la lista de grupos: ${e.message}`, msg);
    }
    const gids = Object.keys(groups || {}).filter(gid => !db.noGmGroups?.[gid]);
    if (!gids.length) return sendText(sock, from, "[ (._.) ] No estoy en ningún grupo kashira (o todos tienen #nogm activo).", msg);

    const broadcastText = `[ (o^-')b ] Mensaje de mi owner principal kashira:\n\n${rest}`;

    let sent = 0, failed = 0;
    for (const gid of gids) {
      try {
        await sock.sendMessage(gid, { text: broadcastText });
        sent++;
      } catch {
        failed++;
      }
      await new Promise(r => setTimeout(r, 300)); // pausa breve para no saturar
    }

    const skipped = Object.keys(groups || {}).length - gids.length;
    await sendText(sock, from, `[ (*^.^*) ] Mensaje global enviado a *${sent}* grupo(s)${failed ? `, falló en ${failed}` : ""}${skipped ? `, omitido en ${skipped} grupo(s) con #nogm activo` : ""} kashira.`, msg);
  }

  else if (finalCmd === "invite") {
    // Antes CUALQUIER persona podía hacer que el bot se uniera a grupos random
    // (solo tenía un límite de 5 usos por persona, no un permiso real). Eso es
    // justo el tipo de comportamiento que WhatsApp marca como sospechoso y
    // puede terminar en que manden la cuenta a revisión. Ahora es exclusivo
    // de owner/sub-owners.
    if (!isOwnerLevel(db, sender)) return sendText(sock, from, "[ x_x ] Solo el owner o sub-owners pueden usar #invite kashira.", msg);
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #invite <link de grupo o comunidad> kashira.", msg);

    // Límite de usos EFECTIVOS (uniones exitosas) por persona, para evitar abuso/spam que
    // pueda arriesgar un ban del número del bot. El owner original no tiene límite.
    const INVITE_MAX_USES = 5;
    db.inviteUses = db.inviteUses || {};
    const usesSoFar = db.inviteUses[senderNum] || 0;
    if (!isOwner(sender) && usesSoFar >= INVITE_MAX_USES) {
      return sendText(sock, from, `[ x_x ] Ya usaste tus *${INVITE_MAX_USES}* invitaciones efectivas kashira. Pídele al owner original que te añada manualmente si necesitas más.`, msg);
    }

    // Acepta con o sin "https://", con o sin "/invite/" (formato viejo), y códigos
    // con guiones/guion bajo (algunos códigos de comunidad los usan).
    const linkMatch = rest.match(/chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9_-]+)/i);
    if (!linkMatch) return sendText(sock, from, "[ x_x ] Ese no es un link de invitación válido de WhatsApp (chat.whatsapp.com/...) kashira.", msg);
    const inviteCode = linkMatch[1];

    let joinedGid;
    try {
      joinedGid = await sock.groupAcceptInvite(inviteCode);
    } catch (e) {
      // "account_reachout_restricted" (y similares como "rate-overlimit") no son un bug del
      // bot: es WhatsApp bloqueando temporalmente que ESTA cuenta se una a más grupos/comunidades,
      // normalmente por unirse a muchos en poco tiempo o por verse como comportamiento de spam.
      // No hay nada que hacer en el código; toca esperar (horas/días) o unir al bot manualmente.
      if (/reachout_restricted|rate.?overlimit|rate.?limit/i.test(e.message || "")) {
        return sendText(sock, from, "[ ;﹏; ] WhatsApp está bloqueando temporalmente que esta cuenta se una a más grupos kashira (límite de la propia cuenta, no del bot). Espera unas horas y vuelve a intentar, o añade al bot manualmente al grupo.", msg);
      }
      return sendText(sock, from, `[ ;﹏; ] No pude unirme kashira: ${e.message}`, msg);
    }
    if (!joinedGid) return sendText(sock, from, "[ x_x ] WhatsApp no devolvió el grupo/comunidad kashira, puede que el link haya expirado.", msg);

    // Cuenta como uso efectivo: ya nos unimos de verdad, así que se descuenta del límite.
    if (!isOwner(sender)) {
      db.inviteUses[senderNum] = usesSoFar + 1;
      saveDB(db);
    }

    let meta;
    try {
      meta = await sock.groupMetadata(joinedGid);
    } catch (e) {
      return sendText(sock, from, `[ (o^-')b ] Me uní a *${joinedGid}* kashira, pero no pude leer sus datos: ${e.message}`, msg);
    }

    let report = `[ (o^-')b ] Me uní a *${meta.subject || joinedGid}* kashira.`;
    if (!isOwner(sender)) {
      report += ` (Invitación *${usesSoFar + 1}/${INVITE_MAX_USES}* usada.)`;
    }

    // Si es una comunidad, WhatsApp normalmente añade automáticamente al bot a los
    // subgrupos "por defecto" de esa comunidad al aceptar la invitación. Baileys no
    // tiene una API para solicitar unirse a TODOS los subgrupos (eso requeriría un
    // link propio por cada uno, o ser aceptado manualmente por un admin de cada uno),
    // así que aquí solo detectamos y reportamos a cuáles quedamos unidos automáticamente.
    if (meta.isCommunity) {
      try {
        const allGroups = await sock.groupFetchAllParticipating();
        const subgroups = Object.values(allGroups || {}).filter(g => g.linkedParent === joinedGid);
        if (subgroups.length) {
          report += `\n\nEs una *comunidad* kashira. Quedé unido automáticamente a estos *${subgroups.length}* subgrupo(s):\n` +
            subgroups.map(g => `▸ ${g.subject}`).join("\n");
        } else {
          report += `\n\nEs una *comunidad* kashira, pero no quedé unido a ningún subgrupo automáticamente. Para los demás subgrupos necesito su link de invitación individual o que un admin me acepte manualmente (WhatsApp no permite unirse a todos los subgrupos de golpe).`;
        }
      } catch (e) {
        report += `\n\nEs una comunidad, pero no pude revisar sus subgrupos: ${e.message}`;
      }
    }

    await sendText(sock, from, report, msg);
  }

  else if (finalCmd === "nogm") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo administradores pueden usar #nogm.", msg);

    db.noGmGroups = db.noGmGroups || {};
    const currentlyOff = !!db.noGmGroups[from];

    if (currentlyOff) {
      delete db.noGmGroups[from];
      saveDB(db);
      return sendText(sock, from, "[ (o^-')b ] Este grupo volverá a recibir los mensajes globales (#gm) kashira.", msg);
    } else {
      db.noGmGroups[from] = true;
      saveDB(db);
      return sendText(sock, from, "[ (¬_¬) ] Este grupo ya NO recibirá los mensajes globales (#gm) kashira. Usa #nogm de nuevo para reactivarlos.", msg);
    }
  }

  else if (finalCmd === "lock") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo admins.", msg);

    db.lockedCommands = db.lockedCommands || {};
    db.lockedCommands[from] = db.lockedCommands[from] || [];

    if (!rest) {
      const list = db.lockedCommands[from];
      const text = list.length
        ? `*⌞ Comandos Bloqueados ⌝*\n━━━━━━━━━━━━━━━━\n${list.map(c => `#${c}`).join(", ")}\n━━━━━━━━━━━━━━━━\nUsa #lock [comando] para bloquear o desbloquear uno kashira.`
        : "[ (o^-')b ] No hay comandos bloqueados en este grupo kashira.\n\nUsa #lock [comando] para bloquear uno.";
      return sendText(sock, from, text, msg);
    }

    const targetRaw = rest.toLowerCase().replace(/^#/, "").split(/\s+/)[0];
    const targetCmd = aliasMap[targetRaw];

    if (!targetCmd) return sendText(sock, from, `[ x_x ] No reconozco el comando *#${targetRaw}* kashira.`, msg);
    if (["lock", "on", "off", "menu"].includes(targetCmd)) {
      return sendText(sock, from, "[ x_x ] Ese comando no se puede bloquear kashira, te dejaría sin salida.", msg);
    }

    if (db.lockedCommands[from].includes(targetCmd)) {
      db.lockedCommands[from] = db.lockedCommands[from].filter(c => c !== targetCmd);
      saveDB(db);
      return sendText(sock, from, `[ (o^-')b ] *#${targetCmd}* desbloqueado kashira.`, msg);
    } else {
      db.lockedCommands[from].push(targetCmd);
      saveDB(db);
      return sendText(sock, from, `[ (⁠¬⁠_⁠¬⁠) ] *#${targetCmd}* bloqueado para no-admins kashira.`, msg);
    }
  }

  else if (finalCmd === "k") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo administradores.", msg);
    const target = resolveToPN(getMentionedJid(msg));
    if (!target) return sendText(sock, from, "[x_x] Debes mencionar o responder a alguien kashira", msg);
    const targetPN = resolveToPN(target);
    const res = await safeGroupParticipantsUpdate(sock, from, targetPN, "remove");
    if (!res.ok) {
      return sendText(sock, from, res.notBotAdmin
        ? "[ x_x ] No pude hacerlo kashira, revisa que YO (Beatrice) sea admin del grupo."
        : "[ x_x ] Esa persona ya no está en el grupo kashira.", msg);
    }
    await sock.sendMessage(from, { text: `[ (x_x) ] @${targetPN.split("@")[0]} Fue eliminado kashira.`, mentions: [targetPN] }, { quoted: msg });
  }

  else if (finalCmd === "del") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo administradores pueden usar #del.", msg);
    if (!contextInfo || !contextInfo.stanzaId) return sendText(sock, from, "[X] Debes responder al mensaje que quieres eliminar Kashira UwU >w<", msg);

    try {
      await sock.sendMessage(from, {
        delete: {
          remoteJid: from,
          fromMe: contextInfo.participant === sock.user.id.split(":")[0] + "@s.whatsapp.net",
          id: contextInfo.stanzaId,
          participant: contextInfo.participant
        }
      });
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] Error al eliminar. Asegúrate de que el bot sea administrador kashira.", msg);
    }
  }

  else if (finalCmd === "admins") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo administradores pueden usar #admins.", msg);

    const meta = await sock.groupMetadata(from);
    updateLidMapFromMeta(meta);
    const adminJids = meta.participants.filter(p => p.admin).map(p => {
      const pn = p.pn || p.phoneNumber;
      return pn ? (pn.includes("@") ? pn : pn + "@s.whatsapp.net") : resolveToPN(p.id);
    });

    if (!adminJids.length) return sendText(sock, from, "[ (._.) ] No encontré administradores kashira.", msg);

    const text = rest || "[ (•ิ_•ิ) ] Atención administradores kashira, se les necesita.";
    await sock.sendMessage(from, { text, mentions: adminJids }, { quoted: msg });
  }

  else if (finalCmd === "invitelink") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo administradores pueden usar #invitelink.", msg);

    try {
      const code = await sock.groupInviteCode(from);
      await sendText(sock, from, `[ (o^-')b ] Aquí está el enlace del grupo kashira:\n\nhttps://chat.whatsapp.com/${code}`, msg);
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] No pude obtener el enlace: " + e.message + "\n\nAsegúrate de que Beatrice sea admin del grupo kashira.", msg);
    }
  }

  else if (finalCmd === "revoke") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo administradores pueden usar #revoke.", msg);

    try {
      const newCode = await sock.groupRevokeInvite(from);
      await sendText(sock, from, `[ (¬_¬) ] El enlace anterior fue revocado kashira. Nuevo enlace:\n\nhttps://chat.whatsapp.com/${newCode}`, msg);
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] No pude revocar el enlace: " + e.message + "\n\nAsegúrate de que Beatrice sea admin del grupo kashira.", msg);
    }
  }

  else if (finalCmd === "setrules") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo administradores pueden usar #setrules.", msg);

    const prefixLen = CONFIG.prefix.length;
    const cmdLen = finalCmd.length;
    const newRules = body.slice(prefixLen + cmdLen).trim();

    if (!newRules) return sendText(sock, from, "[ x_x ] Usa: #setrules [reglas del grupo]", msg);

    db.groupRules = db.groupRules || {};
    db.groupRules[from] = newRules;
    saveDB(db);
    await sendText(sock, from, "[ (o^-')b ] Reglas guardadas kashira! Usa #rules para verlas.", msg);
  }

  else if (finalCmd === "rules") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    const rules = db.groupRules?.[from];
    if (!rules) return sendText(sock, from, "[ (._.) ] Este grupo no tiene reglas guardadas kashira.\n\nUn admin puede guardarlas con #setrules [texto].", msg);
    await sendText(sock, from, `*⌞ Reglas del Grupo ⌝*\n━━━━━━━━━━━━━━━━\n\n${rules}\n\n━━━━━━━━━━━━━━━━`, msg);
  }

  else if (finalCmd === "clearwarns") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo administradores pueden usar #clearwarns.", msg);

    const target = resolveToPN(getMentionedJid(msg));
    if (!target) return sendText(sock, from, "[ x_x ] Debes mencionar o responder a alguien kashira.", msg);
    const targetNum = target.split("@")[0];

    const warns = db.warns?.[from]?.[target] || [];
    if (!warns.length) {
      return sock.sendMessage(from, { text: `[ (o^.^o) ] @${targetNum} no tiene advertencias kashira.`, mentions: [target] }, { quoted: msg });
    }

    db.warns[from][target] = [];
    saveDB(db);
    await sock.sendMessage(from, {
      text: `[ (•̀ᴗ•́)و ] Todas las advertencias de @${targetNum} fueron eliminadas kashira.`,
      mentions: [target]
    }, { quoted: msg });
  }

  // ══════════════════════════════
  //    BIENVENIDAS / DESPEDIDAS / PERFILES
  // ══════════════════════════════

  else if (finalCmd === "wel") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    const msg_text = db.welcomeMsg?.[from] || DEFAULT_WELCOME_MSG;
    await sendText(sock, from, `*⌞ Configuración de Bienvenida ⌝*\n\n(o^-')b Texto actual:\n${msg_text}\n\n_Usa #setwel para cambiarlo, #welimg para la imagen, #twel para probarlo y #on wel / #off wel para prenderlo o apagarlo._`, msg);
  }

  else if (finalCmd === "setwel") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo admins.", msg);
    
    const prefixLen = CONFIG.prefix.length;
    const cmdLen = finalCmd.length;
    const rawText = body.slice(prefixLen + cmdLen).trim();

    if (!rawText) return sendText(sock, from, `[ x_x ] Usa: #setwel [mensaje]\n\nVariables:\n{user} -> Menciona al ingresante\n{grupo} -> Nombre del grupo`, msg);
    
    db.welcomeMsg = db.welcomeMsg || {};
    db.welcomeMsg[from] = rawText;
    saveDB(db);
    await sendText(sock, from, `[ (*^.^*) ] Guardado con soporte de variables:\n\n${rawText}`, msg);
  }

  else if (finalCmd === "welimg") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    const targetImg = msg.message?.imageMessage || quotedContext?.imageMessage;

    if (!targetImg) {
      db.welcomeImg = db.welcomeImg || {};
      const imgKey = db.welcomeImg[from];
      if (!imgKey) return sendText(sock, from, "[ x_x ] Responde a una foto con #welimg (o^-')b", msg);
      return sendText(sock, from, "[ (*^.^*) ] Imagen asignada en el servidor local.", msg);
    }

    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo admins.", msg);
    
    try {
      const buffer = await downloadMedia(targetImg, "image");
      const localPath = path.join(__dirname, `welcome_${from}.jpg`);
      fs.writeFileSync(localPath, buffer);
      
      db.welcomeImg = db.welcomeImg || {};
      db.welcomeImg[from] = localPath;
      saveDB(db);
      await sendText(sock, from, "[ (o^-')b ] Imagen de bienvenida registrada.", msg);
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] Error al guardar: " + e.message, msg);
    }
  }

  else if (finalCmd === "twel") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    const meta = await sock.groupMetadata(from).catch(() => null);
    const subject = meta ? meta.subject : "Grupo de Prueba";
    
    let welcomeText = db.welcomeMsg?.[from] || DEFAULT_WELCOME_MSG;
    welcomeText = welcomeText.replace(/{user}/g, `@${senderNum}`).replace(/{grupo}/g, subject);
    
    db.welcomeImg = db.welcomeImg || {};
    const localImgPath = db.welcomeImg[from];

    if (localImgPath && fs.existsSync(localImgPath)) {
      const imgBuf = fs.readFileSync(localImgPath);
      await sock.sendMessage(from, { image: imgBuf, caption: welcomeText, mentions: [sender] }, { quoted: msg });
    } else {
      await sock.sendMessage(from, { text: welcomeText, mentions: [sender] }, { quoted: msg });
    }
  }

  else if (finalCmd === "bye") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    const msg_text = db.byeMsg?.[from] || DEFAULT_BYE_MSG;
    await sendText(sock, from, `*⌞ Configuración de Despedida ⌝*\n\n(o^-')b Texto actual:\n${msg_text}\n\n_Usa #setbye para cambiarlo, #byeimg para la imagen, #tbye para probarlo y #on bye / #off bye para prenderlo o apagarlo._`, msg);
  }

  else if (finalCmd === "setbye") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo admins.", msg);
    
    const prefixLen = CONFIG.prefix.length;
    const cmdLen = finalCmd.length;
    const rawText = body.slice(prefixLen + cmdLen).trim();

    if (!rawText) return sendText(sock, from, `[ x_x ] Usa: #setbye [mensaje]\n\nVariables:\n{user} -> Menciona al que se fue\n{grupo} -> Nombre del grupo`, msg);
    
    db.byeMsg = db.byeMsg || {};
    db.byeMsg[from] = rawText;
    saveDB(db);
    await sendText(sock, from, `[ (._.)ﾉ ] Guardado con soporte de variables:\n\n${rawText}`, msg);
  }

  else if (finalCmd === "byeimg") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    const targetImg = msg.message?.imageMessage || quotedContext?.imageMessage;

    if (!targetImg) {
      db.byeImg = db.byeImg || {};
      const imgKey = db.byeImg[from];
      if (!imgKey) return sendText(sock, from, "[ x_x ] Responde a una foto con #byeimg (o^-')b", msg);
      return sendText(sock, from, "[ (._.)ﾉ ] Imagen asignada en el servidor local.", msg);
    }

    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo admins.", msg);
    
    try {
      const buffer = await downloadMedia(targetImg, "image");
      const localPath = path.join(__dirname, `bye_${from}.jpg`);
      fs.writeFileSync(localPath, buffer);
      
      db.byeImg = db.byeImg || {};
      db.byeImg[from] = localPath;
      saveDB(db);
      await sendText(sock, from, "[ (o^-')b ] Imagen de despedida registrada.", msg);
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] Error al guardar: " + e.message, msg);
    }
  }

  else if (finalCmd === "tbye") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    const meta = await sock.groupMetadata(from).catch(() => null);
    const subject = meta ? meta.subject : "Grupo de Prueba";
    
    let byeText = db.byeMsg?.[from] || DEFAULT_BYE_MSG;
    byeText = byeText.replace(/{user}/g, `@${senderNum}`).replace(/{grupo}/g, subject);
    
    db.byeImg = db.byeImg || {};
    const localImgPath = db.byeImg[from];

    if (localImgPath && fs.existsSync(localImgPath)) {
      const imgBuf = fs.readFileSync(localImgPath);
      await sock.sendMessage(from, { image: imgBuf, caption: byeText, mentions: [sender] }, { quoted: msg });
    } else {
      await sock.sendMessage(from, { text: byeText, mentions: [sender] }, { quoted: msg });
    }
  }

  else if (finalCmd === "birthday") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    const msg_text = db.birthdayMsg?.[from] || DEFAULT_BIRTHDAY_MSG;
    await sendText(sock, from, `*⌞ Configuración de Cumpleaños ⌝*\n\n(o^-')b Texto actual:\n${msg_text}\n\n_Usa #setbirthday para cambiarlo, #birthdayimg para la imagen, #tbirthday para probarlo y #on birthday / #off birthday para prenderlo o apagarlo._\n_Recuerda: cada quien debe guardar su fecha con #setbirth dd/mm/yyyy._`, msg);
  }

  else if (finalCmd === "setbirthday") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo admins.", msg);

    const prefixLen = CONFIG.prefix.length;
    const cmdLen = finalCmd.length;
    const rawText = body.slice(prefixLen + cmdLen).trim();

    if (!rawText) return sendText(sock, from, `[ x_x ] Usa: #setbirthday [mensaje]\n\nVariables:\n{user} -> Menciona al cumpleañero/a\n{grupo} -> Nombre del grupo\n{edad} -> Edad que cumple`, msg);

    db.birthdayMsg = db.birthdayMsg || {};
    db.birthdayMsg[from] = rawText;
    saveDB(db);
    await sendText(sock, from, `[ (๑˃ᴗ˂)ﻭ ] Guardado con soporte de variables:\n\n${rawText}`, msg);
  }

  else if (finalCmd === "birthdayimg") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    const targetImg = msg.message?.imageMessage || quotedContext?.imageMessage;

    if (!targetImg) {
      db.birthdayImg = db.birthdayImg || {};
      const imgKey = db.birthdayImg[from];
      if (!imgKey) return sendText(sock, from, "[ x_x ] Responde a una foto con #birthdayimg (o^-')b", msg);
      return sendText(sock, from, "[ (*^.^*) ] Imagen asignada en el servidor local.", msg);
    }

    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo admins.", msg);

    try {
      const buffer = await downloadMedia(targetImg, "image");
      const localPath = path.join(__dirname, `birthday_${from}.jpg`);
      fs.writeFileSync(localPath, buffer);

      db.birthdayImg = db.birthdayImg || {};
      db.birthdayImg[from] = localPath;
      saveDB(db);
      await sendText(sock, from, "[ (o^-')b ] Imagen de cumpleaños registrada.", msg);
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] Error al guardar: " + e.message, msg);
    }
  }

  else if (finalCmd === "tbirthday") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    const meta = await sock.groupMetadata(from).catch(() => null);
    const subject = meta ? meta.subject : "Grupo de Prueba";

    const prof = db.profiles?.[senderNum];
    let edad = "??";
    if (prof?.birth) {
      const birthParts = prof.birth.split("/");
      const y = Number(birthParts[2]);
      if (y) edad = new Date().getFullYear() - y;
    }

    let birthdayText = db.birthdayMsg?.[from] || DEFAULT_BIRTHDAY_MSG;
    birthdayText = birthdayText.replace(/{user}/g, `@${senderNum}`).replace(/{grupo}/g, subject).replace(/{edad}/g, edad);

    db.birthdayImg = db.birthdayImg || {};
    const localImgPath = db.birthdayImg[from];

    if (localImgPath && fs.existsSync(localImgPath)) {
      const imgBuf = fs.readFileSync(localImgPath);
      await sock.sendMessage(from, { image: imgBuf, caption: birthdayText, mentions: [sender] }, { quoted: msg });
    } else {
      await sock.sendMessage(from, { text: birthdayText, mentions: [sender] }, { quoted: msg });
    }
  }

  else if (finalCmd === "pfp") {
    if (!isOwnerLevel(db, sender)) return sendText(sock, from, "[ x_x ] Solo el owner.", msg);
    const targetImg = msg.message?.imageMessage || quotedContext?.imageMessage;
    if (!targetImg) return sendText(sock, from, "[ x_x ] Responde o adjunta una foto con #pfp kashira.", msg);

    try {
      const rawBuffer = await downloadMedia(targetImg, "image");
      const processedBuffer = await generateProfilePicture(rawBuffer);

      const myJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";
      await sock.updateProfilePicture(myJid, processedBuffer);
      await sendText(sock, from, "[ (*~▽~)☆ ] ¡Foto de perfil global del bot actualizada kashira!", msg);
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] Falló la subida en servidores: " + e.message, msg);
    }
  }

  else if (finalCmd === "gpfp") {
    if (!isGroup) return sendText(sock, from, "[ x_x ] Comando exclusivo para grupos.", msg);
    if (!(await isAdmin(sock, from, sender)) && !isOwnerLevel(db, sender)) return sendText(sock, from, "[ >.< ] Solo administradores del grupo.", msg);
    
    const targetImg = msg.message?.imageMessage || quotedContext?.imageMessage;
    if (!targetImg) return sendText(sock, from, "[ x_x ] Adjunta o responde a una foto con #setgimg kashira.", msg);

    try {
      const rawBuffer = await downloadMedia(targetImg, "image");
      const processedBuffer = await generateProfilePicture(rawBuffer);

      await sock.updateProfilePicture(from, processedBuffer);
      await sendText(sock, from, "[ (*^.^*) ] ¡La foto de perfil del grupo ha sido modificada con éxito!", msg);
    } catch (e) {
      await sendText(sock, from, "[ ;﹏; ] Error de procesamiento en el grupo: " + e.message, msg);
    }
  }

  // ══════════════════════════════
  //    OWNER ONLY
  // ══════════════════════════════

  else if (finalCmd === "b") {
    if (!isOwnerLevel(db, sender)) return sendText(sock, from, "[ x_x ] Solo el owner.", msg);
    const target = resolveToPN(getMentionedJid(msg));
    if (!target) return sendText(sock, from, "[ x_x ] Menciona al usuario.", msg);
    const targetNum = target.split("@")[0];
    db.bannedUsers = db.bannedUsers || {};
    if (db.bannedUsers[targetNum]) {
      delete db.bannedUsers[targetNum];
      saveDB(db);
      return sock.sendMessage(from, { text: `[ (*^.^*) ] @${targetNum} Desbaneado.`, mentions: [target] }, { quoted: msg });
    }
    db.bannedUsers[targetNum] = true;
    saveDB(db);
    await sock.sendMessage(from, { text: `[ (x_x) ] @${targetNum} Baneado del bot.`, mentions: [target] }, { quoted: msg });
  }

else if (finalCmd === "bi") {
    if (!isOwnerLevel(db, sender)) return sendText(sock, from, "[ x_x ] Solo el owner.", msg);

    const uptime = process.uptime();
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = Math.floor(uptime % 60);

    const mem = process.memoryUsage();
    const ramUsedMB = (mem.rss / 1024 / 1024).toFixed(1);

    let groupCount = "?";
    try {
        const allGroups = await sock.groupFetchAllParticipating();
        groupCount = Object.keys(allGroups || {}).length;
    } catch (e) {
        console.error("Error en comando bi (conteo de grupos):", e.message);
    }

    try {
        let pp;
        try {
            pp = await sock.profilePictureUrl(sock.user.id, 'image');
        } catch (e) {
            pp = 'https://telegra.ph/file/24fa902ead26340f3df2c.png';
        }

        const caption = `*⌞ Estado del Bot ⌝*\n` +
            `━━━━━━━━━━━━━━━━\n\n` +
            `[ (o^-')b ] *Bot:* ${CONFIG.botName}\n\n` +
            `[ (✧ω✧) ] *Versión:* ${CONFIG.version}\n\n` +
            `[ (p^.^q) ] *Uptime:* ${h}h ${m}m ${s}s\n\n` +
            `[ (•ิ_•ิ) ] *Motor:* Node.js ${process.version}\n\n` +
            `[ (⁠｡⁠•̀⁠ᴗ⁠-⁠)⁠✧ ] *RAM en uso:* ${ramUsedMB} MB\n\n` +
            `[ (๑˃ᴗ˂)ﻭ ] *Grupos activos:* ${groupCount}\n\n` +
            `[ (^w^) ] *Owner:* ${CONFIG.ownerName}\n\n` +
            `━━━━━━━━━━━━━━━━`;

        await sock.sendMessage(from, {
            image: { url: pp },
            caption: caption
        }, { quoted: msg });

    } catch (error) {
        console.error("Error en comando bi:", error);
        await sendText(sock, from, "[ ! ] Error al obtener estado.", msg);
    }
}
  // ══════════════════════════════
  //    HELP / MENU (CON FOTO)
  // ══════════════════════════════

  else if (finalCmd === "menu") {
    const cat = rest.toLowerCase();
    const menuText = MENU[cat] || MENU.main;

    try {
      const myJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";
      const currentPfp = await sock.profilePictureUrl(myJid, "image").catch(() => null);

      if (currentPfp) {
        await sock.sendMessage(from, { image: { url: currentPfp }, caption: menuText }, { quoted: msg });
      } else {
        await sendText(sock, from, menuText, msg);
      }
    } catch {
      await sendText(sock, from, menuText, msg);
    }
  }

  // ══════════════════════════════
  //    ECONOMÍA
  // ══════════════════════════════

  else if (finalCmd === "work") {
    const eco = getEco(db, from, senderNum);
    const cd = ecoCooldown(eco, ECO.WORK_CD, db.profiles?.[senderNum]);
    const now = Date.now();
    const elapsed = now - eco.lastWork;
    if (elapsed < cd) {
      return sendText(sock, from, `[ (¬_¬) ] Espera *${fmtCooldown(cd - elapsed)}* antes de volver a trabajar kashira.`, msg);
    }
    let amount = randInt(ECO.WORK_MIN, ECO.WORK_MAX);
    if (eco.advantages.ganancia) amount *= 2;
    eco.wallet += amount;
    eco.lastWork = now;
    eco.lastActive = now;
    saveDB(db);
    const line = pick(WORK_TEXTS).replace("{amount}", fmtM(amount));
    await sock.sendMessage(from, {
      text: `[ (p^.^q) ] ${line}`,
      mentions: [sender]
    }, { quoted: msg });
  }

  else if (finalCmd === "dungeon") {
    const eco = getEco(db, from, senderNum);
    const cd = ecoCooldown(eco, ECO.DUNGEON_CD, db.profiles?.[senderNum]);
    const now = Date.now();
    const elapsed = now - eco.lastDungeon;
    if (elapsed < cd) {
      return sendText(sock, from, `[ (¬_¬) ] Espera *${fmtCooldown(cd - elapsed)}* antes de volver a la mazmorra kashira.`, msg);
    }
    eco.lastDungeon = now;
    eco.lastActive = now;
    const died = consumeJinx(db, from, senderNum) || Math.random() < badChanceWithLuck(db, from, senderNum, ECO.DUNGEON_DEATH_CHANCE);
    if (died) {
      let loss = Math.round(eco.wallet * ECO.DUNGEON_DEATH_LOSS_PCT);
      eco.wallet -= loss;
      saveDB(db);
      const line = pick(DUNGEON_DEATH_TEXTS).replace("{amount}", fmtM(loss));
      await sock.sendMessage(from, { text: `[ °﹏° ] ${line}`, mentions: [sender] }, { quoted: msg });
    } else {
      let amount = randInt(ECO.DUNGEON_MIN, ECO.DUNGEON_MAX);
      if (eco.advantages.ganancia) amount *= 2;
      eco.wallet += amount;
      saveDB(db);
      const line = pick(DUNGEON_TEXTS).replace("{amount}", fmtM(amount));
      await sock.sendMessage(from, { text: `[ (ノ°益°)ノ ] ${line}`, mentions: [sender] }, { quoted: msg });
    }
  }

  else if (finalCmd === "ritual") {
    const eco = getEco(db, from, senderNum);
    const cd = ecoCooldown(eco, ECO.RITUAL_CD, db.profiles?.[senderNum]);
    const now = Date.now();
    const elapsed = now - eco.lastRitual;
    if (elapsed < cd) {
      return sendText(sock, from, `[ (¬_¬) ] Espera *${fmtCooldown(cd - elapsed)}* antes de hacer otro ritual kashira.`, msg);
    }
    eco.lastRitual = now;
    eco.lastActive = now;
    const absorbed = consumeJinx(db, from, senderNum) || Math.random() < badChanceWithLuck(db, from, senderNum, ECO.RITUAL_ABSORB_CHANCE);
    if (absorbed) {
      const total = eco.wallet + eco.bank;
      const loss = Math.round(total * ECO.RITUAL_ABSORB_LOSS_PCT);
      const fromWallet = Math.min(eco.wallet, loss);
      eco.wallet -= fromWallet;
      eco.bank -= (loss - fromWallet);
      saveDB(db);
      const line = pick(RITUAL_ABSORB_TEXTS).replace("{amount}", fmtM(loss));
      await sock.sendMessage(from, { text: `[ (⁠×⁠_⁠×⁠) ] ${line}`, mentions: [sender] }, { quoted: msg });
    } else {
      let amount = randInt(ECO.RITUAL_MIN, ECO.RITUAL_MAX);
      if (eco.advantages.ganancia) amount *= 2;
      eco.wallet += amount;
      saveDB(db);
      const line = pick(RITUAL_TEXTS).replace("{amount}", fmtM(amount));
      await sock.sendMessage(from, { text: `[ (⊙_◎) ] ${line}`, mentions: [sender] }, { quoted: msg });
    }
  }

  else if (finalCmd === "adventure") {
    const eco = getEco(db, from, senderNum);
    const cd = ecoCooldown(eco, ECO.ADVENTURE_CD, db.profiles?.[senderNum]);
    const now = Date.now();
    const elapsed = now - eco.lastAdventure;
    if (elapsed < cd) {
      return sendText(sock, from, `[ (¬_¬) ] Espera *${fmtCooldown(cd - elapsed)}* antes de tu siguiente aventura kashira.`, msg);
    }
    eco.lastAdventure = now;
    eco.lastActive = now;
    const delayed = consumeJinx(db, from, senderNum) || Math.random() < badChanceWithLuck(db, from, senderNum, ECO.ADVENTURE_EVENT_CHANCE);
    if (delayed) {
      // La ventaja de cooldown reduce a la mitad el retraso extra, igual que reduce los cooldowns normales.
      const delay = eco.advantages?.cooldown ? Math.floor(ECO.ADVENTURE_DELAY_MS / 2) : ECO.ADVENTURE_DELAY_MS;
      for (const field of ECO_COOLDOWN_FIELDS) {
        eco[field] = (eco[field] || 0) + delay;
      }
      saveDB(db);
      const line = pick(ADVENTURE_DELAY_TEXTS);
      await sock.sendMessage(from, { text: `[ (._.) ] ${line}\n\n_Se te sumaron ${fmtCooldown(delay)} a todos tus cooldowns activos._`, mentions: [sender] }, { quoted: msg });
    } else {
      let amount = randInt(ECO.ADVENTURE_MIN, ECO.ADVENTURE_MAX);
      if (eco.advantages.ganancia) amount *= 2;
      eco.wallet += amount;
      saveDB(db);
      const line = pick(ADVENTURE_TEXTS).replace("{amount}", fmtM(amount));
      await sock.sendMessage(from, { text: `[ (๑>ᴗ<)ᕗ ] ${line}`, mentions: [sender] }, { quoted: msg });
    }
  }

  else if (finalCmd === "slut") {
    const eco = getEco(db, from, senderNum);
    const cd = ecoCooldown(eco, ECO.SLUT_CD, db.profiles?.[senderNum]);
    const now = Date.now();
    const elapsed = now - eco.lastSlut;
    if (elapsed < cd) {
      return sendText(sock, from, `[ (¬_¬) ] Espera *${fmtCooldown(cd - elapsed)}* antes de repetir kashira.`, msg);
    }
    eco.lastSlut = now;
    eco.lastActive = now;
    const failed = consumeJinx(db, from, senderNum) || Math.random() < badChanceWithLuck(db, from, senderNum, ECO.SLUT_FAIL_CHANCE);
    if (failed) {
      let loss = randInt(ECO.SLUT_FAIL_MIN, ECO.SLUT_FAIL_MAX);
      loss = Math.min(loss, eco.wallet);
      eco.wallet -= loss;
      saveDB(db);
      const line = pick(SLUT_FAIL_TEXTS).replace("{amount}", fmtM(loss));
      await sock.sendMessage(from, { text: `[ (⁠¬⁠‿⁠¬⁠) ] ${line}`, mentions: [sender] }, { quoted: msg });
    } else {
      let amount = randInt(ECO.SLUT_MIN, ECO.SLUT_MAX);
      if (eco.advantages.ganancia) amount *= 2;
      eco.wallet += amount;
      saveDB(db);
      const line = pick(SLUT_TEXTS).replace("{amount}", fmtM(amount));
      await sock.sendMessage(from, { text: `[ (⁠｡⁠>⁠‿⁠<⁠｡⁠) ] ${line}`, mentions: [sender] }, { quoted: msg });
    }
  }

  else if (finalCmd === "crime") {
    const eco = getEco(db, from, senderNum);
    const cd = ecoCooldown(eco, ECO.CRIME_CD, db.profiles?.[senderNum]);
    const now = Date.now();
    const elapsed = now - eco.lastCrime;
    if (elapsed < cd) {
      return sendText(sock, from, `[ (¬_¬) ] Espera *${fmtCooldown(cd - elapsed)}* antes de cometer otro crimen kashira.`, msg);
    }
    eco.lastCrime = now;
    eco.lastActive = now;
    const failed = consumeJinx(db, from, senderNum) || Math.random() < badChanceWithLuck(db, from, senderNum, ECO.CRIME_FAIL_CHANCE);
    if (failed) {
      let loss = randInt(ECO.CRIME_FAIL_MIN, ECO.CRIME_FAIL_MAX);
      loss = Math.min(loss, eco.wallet);
      eco.wallet -= loss;
      saveDB(db);
      const line = pick(CRIME_FAIL_TEXTS).replace("{amount}", fmtM(loss));
      await sock.sendMessage(from, {
        text: `[ °﹏° ] ${line}`,
        mentions: [sender]
      }, { quoted: msg });
    } else {
      let amount = randInt(ECO.CRIME_MIN, ECO.CRIME_MAX);
      if (eco.advantages.ganancia) amount *= 2;
      eco.wallet += amount;
      saveDB(db);
      const line = pick(CRIME_WIN_TEXTS).replace("{amount}", fmtM(amount));
      await sock.sendMessage(from, {
        text: `[ (¬‿¬) ] ${line}`,
        mentions: [sender]
      }, { quoted: msg });
    }
  }

  else if (finalCmd === "grind") {
    const eco = getEco(db, from, senderNum);
    if (!eco.advantages.grind) {
      return sendText(sock, from, "[ x_x ] No tienes la ventaja *Grind* kashira, cómprala en #shop ventajas (500,000¥).", msg);
    }
    const prof = db.profiles?.[senderNum];

    // Se calcula quién está listo ANTES de correr nada (ver el comentario arriba de
    // GRIND_ACTIVITIES sobre por qué no se puede revisar y ejecutar en el mismo paso).
    const ready = GRIND_ACTIVITIES.filter(cfg => isGrindActivityReady(eco, prof, cfg));
    if (!ready.length) {
      return sendText(sock, from, "[ (¬_¬) ] Ninguna de tus actividades está lista todavía kashira, revisa #einfo.", msg);
    }

    const results = ready.map(cfg => runGrindActivity(db, from, senderNum, cfg));
    saveDB(db);

    const lines = results.map(r => `${r.ok ? "(^ω^)" : "(x_x)"} ${r.label}: ${r.text}`).join("\n");
    await sendText(sock, from, `*⌞ Grind ⌝*\n━━━━━━━━━━━━━━━━\n\n${lines}\n━━━━━━━━━━━━━━━━`, msg);
  }

  else if (finalCmd === "daily") {
    const eco = getEco(db, from, senderNum);
    const now = Date.now();
    const elapsed = now - (eco.lastDaily || 0);
    if (elapsed < ECO.DAILY_CD) {
      return sendText(sock, from, `[ (¬_¬) ] Espera *${fmtCooldown(ECO.DAILY_CD - elapsed)}* antes de tu siguiente daily kashira.`, msg);
    }

    // Si dejaste pasar más de 48h desde el último daily, se rompe la racha.
    if (elapsed > ECO.DAILY_STREAK_RESET) {
      eco.dailyStreak = 0;
    }
    eco.dailyStreak = (eco.dailyStreak || 0) + 1;

    let amount = ECO.DAILY_BASE + ECO.DAILY_STREAK_BONUS * eco.dailyStreak;
    if (eco.advantages?.ganancia) amount *= 2;

    eco.wallet += amount;
    eco.lastDaily = now;
    eco.lastActive = now;
    saveDB(db);

    await sock.sendMessage(from, {
      text: `[ (๑˃ᴗ˂)ﻭ ] ¡Reclamaste tu daily kashira!\n\n(o^-')b Racha: *${eco.dailyStreak} día${eco.dailyStreak === 1 ? "" : "s"}*\n(*^.^*) Ganaste: *${fmtM(amount)}*`,
      mentions: [sender]
    }, { quoted: msg });
  }

  else if (finalCmd === "mine" || finalCmd === "fish") {
    const kind = finalCmd === "mine" ? "pico" : "cana";
    const activityName = finalCmd === "mine" ? "minar" : "pescar";
    const eco = getEco(db, from, senderNum);
    const g = getGather(eco);
    const now = Date.now();

    if (kind === "pico" && now < g.mineDeathUntil) {
      return sendText(sock, from, `[ (×_×) ] Sigues recuperándote de tu casi-muerte en la mina kashira, espera *${fmtCooldown(g.mineDeathUntil - now)}*.`, msg);
    }

    const cd = ecoCooldown(eco, GATHER.CD, db.profiles?.[senderNum]);
    const lastKey = kind === "pico" ? "lastMine" : "lastFish";
    const elapsed = now - (g[lastKey] || 0);
    if (elapsed < cd) {
      return sendText(sock, from, `[ (¬_¬) ] Espera *${fmtCooldown(cd - elapsed)}* antes de volver a ${activityName} kashira.`, msg);
    }

    const equipped = getEquippedTool(g, kind);
    if (!equipped) {
      const toolWord = kind === "pico" ? "pico" : "caña";
      return sendText(sock, from, `[ x_x ] No tienes ${kind === "pico" ? "un" : "una"} ${toolWord} equipado kashira. Compra uno con *#buy ${toolWord} [cantidad]*.`, msg);
    }

    const zoneArg = rest.trim() ? parseInt(rest.trim(), 10) : 1;
    const zone = findZone(kind, zoneArg || 1);
    if (!zone) return sendText(sock, from, `[ x_x ] Esa zona no existe kashira. Usa un número del 1 al 5 (#${finalCmd} [zona]).`, msg);
    if (equipped.tool.level < zone.minTool) {
      return sendText(sock, from, `[ x_x ] *${zone.name}* requiere al menos un *${toolName(kind, zone.minTool)}* equipado kashira.`, msg);
    }

    g[lastKey] = now;
    eco.lastActive = now;

    // Muerte en la mina (solo #mine)
    const deathChance = eco.advantages?.inmortal ? GATHER.DEATH_CHANCE / 2 : GATHER.DEATH_CHANCE;
    if (kind === "pico" && Math.random() < deathChance) {
      const lostWallet = Math.floor(eco.wallet * GATHER.DEATH_LOSS_PCT);
      eco.wallet -= lostWallet;
      const lostMatsMsg = [];
      for (const [id, qty] of Object.entries(g.materials)) {
        const lost = Math.ceil(qty * GATHER.DEATH_LOSS_PCT);
        if (lost > 0) {
          g.materials[id] = Math.max(0, qty - lost);
          if (g.materials[id] === 0) delete g.materials[id];
          lostMatsMsg.push(`${lost}x ${materialName(id)}`);
        }
      }
      toolList(g, kind).splice(equipped.idx, 1);
      autoEquipBest(g, kind);
      g.mineDeathUntil = now + GATHER.DEATH_CD;
      saveDB(db);
      return await sock.sendMessage(from, {
        text: `[ (×_×) ] ¡Casi mueres en *${zone.name}* kashira! Tu pico se rompió en el derrumbe.\n` +
          `Perdiste *${fmtM(lostWallet)}* de tu bolsillo${lostMatsMsg.length ? ` y ${lostMatsMsg.join(", ")}` : ""}.\n` +
          `No podrás volver a minar en *12 minutos* kashira.`,
        mentions: [sender]
      }, { quoted: msg });
    }

    // Drops normales
    let numDrops = randInt(GATHER.DROPS_MIN, GATHER.DROPS_MAX);
    if (eco.advantages?.botin) numDrops *= 2;
    const gained = {};
    for (let i = 0; i < numDrops; i++) {
      const id = weightedPick(zone.table);
      gained[id] = (gained[id] || 0) + 1;
      g.materials[id] = (g.materials[id] || 0) + 1;
    }

    let tip = randInt(GATHER.TIP_MIN, GATHER.TIP_MAX);
    if (eco.advantages?.ganancia) tip *= 2;
    eco.wallet += tip;

    // Desgaste de la herramienta equipada
    equipped.tool.usesLeft -= 1;
    let brokeMsg = "";
    if (equipped.tool.usesLeft <= 0) {
      const brokenName = toolName(kind, equipped.tool.level);
      toolList(g, kind).splice(equipped.idx, 1);
      autoEquipBest(g, kind);
      brokeMsg = `\n\n(¬_¬) Tu *${brokenName}* se quedó sin usos y se rompió.`;
    }

    // Cofre
    let chestMsg = "";
    const chestChance = eco.advantages?.suerte ? GATHER.CHEST_CHANCE * 2 : GATHER.CHEST_CHANCE;
    if (Math.random() < chestChance) {
      chestMsg = handleChestFound(sock, db, from, senderNum, eco, g, zone, kind);
    }

    saveDB(db);

    const dropsLines = Object.entries(gained).map(([id, qty]) => ` > ${qty}x ${materialName(id)}`).join("\n");
    const verb = finalCmd === "mine" ? "Minaste" : "Pescaste";
    const mainText = `[ (⌐■_■) ] ${verb} en *${zone.name}* y encontraste:\n${dropsLines}\n > *${fmtM(tip)}*`;
    await sock.sendMessage(from, {
      text: `${mainText}${chestMsg}${brokeMsg}`,
      mentions: [sender]
    }, { quoted: msg });
  }

  else if (finalCmd === "sell") {
    const eco = getEco(db, from, senderNum);
    const g = getGather(eco);
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #sell [material] [cantidad|all], o #sell all para vender todo kashira.", msg);

    const trimmed = rest.trim();
    if (normalizeText(trimmed) === "all" || normalizeText(trimmed) === "todo") {
      const entries = Object.entries(g.materials).filter(([, qty]) => qty > 0);
      if (!entries.length) return sendText(sock, from, "[ x_x ] No tienes materiales para vender kashira.", msg);
      let total = 0;
      const soldLines = [];
      for (const [id, qty] of entries) {
        let subtotal = qty * materialSell(id);
        if (eco.advantages?.ganancia) subtotal *= 2;
        total += subtotal;
        soldLines.push(` > ${qty}x ${materialName(id)} — *${fmtM(subtotal)}*`);
      }
      g.materials = {};
      eco.wallet += total;
      saveDB(db);
      await sock.sendMessage(from, {
        text: `[ (^ω^) ] Vendiste todos tus materiales:\n${soldLines.join("\n")}\n > *${fmtM(total)}*`,
        mentions: [sender]
      }, { quoted: msg });
      return;
    }

    const parts = trimmed.split(/\s+/);
    let qtyStr = null;
    let nameParts = parts;
    const lastWord = parts[parts.length - 1];
    if (parts.length > 1 && (normalizeText(lastWord) === "all" || normalizeText(lastWord) === "todo")) {
      qtyStr = "all";
      nameParts = parts.slice(0, -1);
    } else if (parts.length > 1 && /^\d+$/.test(lastWord)) {
      qtyStr = lastWord;
      nameParts = parts.slice(0, -1);
    }

    const materialQuery = normalizeText(nameParts.join(" "));
    const matchId =
      Object.keys(MATERIALS).find(id => normalizeText(materialName(id)) === materialQuery) ||
      Object.keys(MATERIALS).find(id => normalizeText(materialName(id)).includes(materialQuery));
    if (!matchId) return sendText(sock, from, "[ x_x ] No reconozco ese material kashira. Revisa tu #inv.", msg);

    const owned = g.materials[matchId] || 0;
    if (owned <= 0) return sendText(sock, from, "[ x_x ] No tienes ese material kashira.", msg);

    const qty = qtyStr === "all" || qtyStr === null ? owned : Math.min(parseInt(qtyStr, 10), owned);
    if (!qty || qty <= 0) return sendText(sock, from, "[ x_x ] Cantidad inválida kashira.", msg);

    let value = qty * materialSell(matchId);
    if (eco.advantages?.ganancia) value *= 2;
    g.materials[matchId] -= qty;
    if (g.materials[matchId] <= 0) delete g.materials[matchId];
    eco.wallet += value;
    saveDB(db);
    await sock.sendMessage(from, {
      text: `[ (^ω^) ] Vendiste:\n > ${qty}x ${materialName(matchId)}\n > *${fmtM(value)}*`,
      mentions: [sender]
    }, { quoted: msg });
  }

  else if (finalCmd === "craft") {
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #craft llave [zona 1-5] kashira, para craftear una llave de lago con materiales de minería.", msg);
    const eco = getEco(db, from, senderNum);
    const g = getGather(eco);
    const m = normalizeText(rest.trim()).match(/^llave\s+(\d+)$/);
    if (!m) return sendText(sock, from, "[ x_x ] Usa: #craft llave [zona 1-5] kashira.", msg);
    const zoneId = parseInt(m[1], 10);
    const zone = findZone("cana", zoneId);
    if (!zone) return sendText(sock, from, "[ x_x ] Esa zona de pesca no existe kashira. Usa un número del 1 al 5.", msg);

    const missing = Object.entries(zone.keyRecipe).find(([id, need]) => (g.materials[id] || 0) < need);
    if (missing) {
      const recipeText = Object.entries(zone.keyRecipe).map(([id, need]) => `${need}x ${materialName(id)}`).join(", ");
      return sendText(sock, from, `[ x_x ] Te faltan materiales kashira. Necesitas: ${recipeText}.`, msg);
    }
    for (const [id, need] of Object.entries(zone.keyRecipe)) {
      g.materials[id] -= need;
      if (g.materials[id] <= 0) delete g.materials[id];
    }
    g.fishKeys[zoneId] = (g.fishKeys[zoneId] || 0) + 1;

    let chestBonus = "";
    const pending = g.pendingChest;
    if (pending && pending.kind === "cana" && pending.zoneId === zoneId && pending.expiresAt > Date.now()) {
      g.pendingChest = null;
      g.fishKeys[zoneId] -= 1;
      if (g.fishKeys[zoneId] <= 0) delete g.fishKeys[zoneId];
      chestBonus = openChestReward(eco, g, zone);
    }

    saveDB(db);
    await sendText(sock, from, `[ (o^-')b ] Crafteaste una llave para *${zone.name}* kashira.${chestBonus}`, msg);
  }

  else if (finalCmd === "tools") {
    await sendText(sock, from, buildHerramientasText(), msg);
  }

  else if (finalCmd === "zones") {
    await sendText(sock, from, buildZonasText(), msg);
  }

  else if (finalCmd === "mats") {
    await sendText(sock, from, buildMaterialesText(), msg);
  }

  else if (finalCmd === "keys") {
    await sendText(sock, from, buildLlavesText(), msg);
  }

  else if (finalCmd === "deposit") {
    const eco = getEco(db, from, senderNum);
    const cap = getBankCap(eco);
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #d [monto|all] kashira.", msg);
    let amount = rest.toLowerCase() === "all" ? eco.wallet : parseInt(rest.replace(/\D/g, ""), 10);
    if (!amount || amount <= 0) return sendText(sock, from, "[ x_x ] Monto inválido kashira.", msg);
    if (amount > eco.wallet) return sendText(sock, from, "[ x_x ] No tienes esa cantidad fuera del banco kashira.", msg);
    const room = cap - eco.bank;
    if (room <= 0) return sendText(sock, from, `[ x_x ] Tu banco en este grupo ya está al tope (*${fmtM(cap)}*) kashira. Compra una mejora en *#shop banco* para poder guardar más.`, msg);
    let clamped = false;
    if (amount > room) {
      amount = room;
      clamped = true;
    }
    eco.wallet -= amount;
    eco.bank += amount;
    eco.lastActive = Date.now();
    saveDB(db);
    await sock.sendMessage(from, {
      text: `[ (o^-')b ] Depositaste *${fmtM(amount)}* kashira @${senderNum}.${clamped ? `\n\n_Tu banco llegó a su tope (${fmtM(cap)}), no se depositó todo lo que pediste. Compra una mejora en #shop banco._` : ""}\n\nBolsillo: *${fmtM(eco.wallet)}*\nBanco: *${fmtM(eco.bank)}*`,
      mentions: [sender]
    }, { quoted: msg });
  }

  else if (finalCmd === "withdraw") {
    const eco = getEco(db, from, senderNum);
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #with [monto|all] kashira.", msg);
    const amount = rest.toLowerCase() === "all" ? eco.bank : parseInt(rest.replace(/\D/g, ""), 10);
    if (!amount || amount <= 0) return sendText(sock, from, "[ x_x ] Monto inválido kashira.", msg);
    if (amount > eco.bank) return sendText(sock, from, "[ x_x ] No tienes esa cantidad en el banco kashira.", msg);
    eco.bank -= amount;
    eco.wallet += amount;
    eco.lastActive = Date.now();
    saveDB(db);
    await sock.sendMessage(from, {
      text: `[ (p^.^q) ] Retiraste *${fmtM(amount)}* kashira @${senderNum}. Recuerda que fuera del banco puede robártelo alguien con #steal.\n\nBolsillo: *${fmtM(eco.wallet)}*\nBanco: *${fmtM(eco.bank)}*`,
      mentions: [sender]
    }, { quoted: msg });
  }

  else if (finalCmd === "steal") {
    const eco = getEco(db, from, senderNum);
    const target = resolveMentionOrNick(db, msg, senderNum, rest);
    if (!target) return sendText(sock, from, "[ x_x ] Menciona a quien quieres robarle kashira.\n\nUsa: #steal @usuario", msg);
    const targetNum = findProfileNum(db, target) || target.split("@")[0].split(":")[0];
    if (targetNum === senderNum) return sendText(sock, from, "[ x_x ] No puedes robarte a ti mismo/a kashira °﹏°", msg);

    const now = Date.now();
    const cd = ecoCooldown(eco, ECO.STEAL_CD, db.profiles?.[senderNum]);
    if (now - eco.lastSteal < cd) {
      return sendText(sock, from, `[ (¬_¬) ] Espera *${fmtCooldown(cd - (now - eco.lastSteal))}* antes de robar de nuevo kashira.`, msg);
    }

    const targetEco = getEco(db, from, targetNum);
    if (now - (targetEco.lastActive || 0) < ECO.STEAL_TARGET_INACTIVE) {
      return sock.sendMessage(from, { text: `[ (¬_¬) ] @${targetNum} ha estado activo/a hace poco kashira, no puedes robarle todavía.`, mentions: [target] }, { quoted: msg });
    }
    if (targetEco.wallet < ECO.STEAL_MIN_TARGET_WALLET) {
      return sock.sendMessage(from, { text: `[ x_x ] @${targetNum} no tiene suficiente dinero fuera del banco kashira (mínimo ${fmtM(ECO.STEAL_MIN_TARGET_WALLET)}).`, mentions: [target] }, { quoted: msg });
    }

    eco.lastSteal = now;
    eco.lastActive = now;
    const success = !consumeJinx(db, from, senderNum) && Math.random() < goodChanceWithLuck(db, from, senderNum, ECO.STEAL_SUCCESS_CHANCE);

    if (!success) {
      saveDB(db);
      const line = pick(STEAL_FAIL_TEXTS).replace("{target}", targetNum);
      return await sock.sendMessage(from, {
        text: `*⌞ Robo Fallido ⌝*\n━━━━━━━━━━━━━━━━\n\n[ °﹏° ] ${line}\n\n(._.) No hubo penalización kashira @${senderNum}.\n━━━━━━━━━━━━━━━━`,
        mentions: [sender, target]
      }, { quoted: msg });
    }

    const pct = ECO.STEAL_MIN_PCT + Math.random() * (ECO.STEAL_MAX_PCT - ECO.STEAL_MIN_PCT);
    const stolen = Math.floor(targetEco.wallet * pct);
    targetEco.wallet -= stolen;
    eco.wallet += stolen;
    saveDB(db);
    const line = pick(STEAL_SUCCESS_TEXTS).replace("{target}", targetNum);
    await sock.sendMessage(from, {
      text: `*⌞ Robo Exitoso ⌝*\n━━━━━━━━━━━━━━━━\n\n[ (¬‿¬) ] ${line}\n\n(o^-')b Robaste *${fmtM(stolen)}* kashira @${senderNum}.\n━━━━━━━━━━━━━━━━`,
      mentions: [sender, target]
    }, { quoted: msg });
  }

  else if (finalCmd === "bal") {
    const target = resolveMentionOrNick(db, msg, senderNum, rest);
    const targetNum = target ? (findProfileNum(db, target) || target.split("@")[0].split(":")[0]) : senderNum;
    const targetJid = target || sender;
    const eco = getEco(db, from, targetNum);
    saveDB(db);
    await sock.sendMessage(from, {
      text: `*⌞ Saldo de @${targetNum} (este grupo) ⌝*\n━━━━━━━━━━━━━━━━\n\n(p^.^q) Bolsillo: *${fmtM(eco.wallet)}*\n(o^-')b Banco: *${fmtM(eco.bank)}* / ${fmtM(getBankCap(eco))}\n(*^.^*) Total: *${fmtM(eco.wallet + eco.bank)}*\n━━━━━━━━━━━━━━━━`,
      mentions: [targetJid]
    }, { quoted: msg });
  }

  else if (finalCmd === "einfo") {
    // "Privado" es sobre a quién le aplica, no sobre el canal: siempre es TU propia
    // info, nunca se puede consultar (ni forzar) la de alguien más. Responde normal
    // en el mismo chat donde se usó.
    if (!db.profiles?.[senderNum]) return sendText(sock, from, "[ x_x ] Primero crea tu perfil con #createprofile kashira.", msg);
    const prof = db.profiles[senderNum];
    const now = Date.now();
    const fmtCd = (remaining) => (remaining > 0 ? fmtCooldown(remaining) : "(^ω^) listo");

    const lines = [];

    if (isGroup) {
      const eco = getEco(db, from, senderNum);
      const econCds = [
        ["Work", "lastWork", ECO.WORK_CD],
        ["Crime", "lastCrime", ECO.CRIME_CD],
        ["Steal", "lastSteal", ECO.STEAL_CD],
        ["Dungeon", "lastDungeon", ECO.DUNGEON_CD],
        ["Ritual", "lastRitual", ECO.RITUAL_CD],
        ["Adventure", "lastAdventure", ECO.ADVENTURE_CD],
        ["Slut", "lastSlut", ECO.SLUT_CD],
        ["Coinflip", "lastCf", ECO.CF_CD],
        ["Ruleta", "lastRt", ECO.RT_CD],
        ["Slots", "lastSlots", ECO.SLOTS_CD],
        ["Dados", "lastDice", ECO.DICE_CD],
        ["Minar", "lastMine", GATHER.CD],
        ["Pescar", "lastFish", GATHER.CD],
      ];
      for (const [label, field, baseCd] of econCds) {
        const cd = ecoCooldown(eco, baseCd, prof);
        const remaining = cd - (now - (eco[field] || 0));
        lines.push(`${label}: ${fmtCd(remaining)}`);
      }
      // #daily NO pasa por ecoCooldown en su código real (no lo afecta la ventaja de
      // la tienda ni los hijos/mascota), así que se calcula aparte sin esos ajustes.
      lines.push(`Daily: ${fmtCd(ECO.DAILY_CD - (now - (eco.lastDaily || 0)))}`);
    } else {
      lines.push("_(los cooldowns de economía son por grupo; escribe #einfo dentro de un grupo para verlos)_");
    }

    if (prof.pet) {
      lines.push(`Feedpet: ${fmtCd(PET_FEED_CD - (now - (prof.pet.lastFed || 0)))}`);
      lines.push(`Playpet: ${fmtCd(PET_PLAY_CD - (now - (prof.pet.lastPlayed || 0)))}`);
    }
    lines.push(`Preg: ${fmtCd(KID_PREG_CD - (now - (prof.lastPreg || 0)))}`);
    lines.push(`Pvsp/Acceptvs: ${fmtCd(PVSP_CD - (now - (prof.lastPvspBattle || 0)))}`);

    const text = `*⌞ Tus cooldowns ⌝*\n━━━━━━━━━━━━━━━━\n\n${lines.join("\n")}\n━━━━━━━━━━━━━━━━`;

    await sendText(sock, from, text, msg);
  }


  else if (finalCmd === "cf") {
    const eco = getEco(db, from, senderNum);
    const cd = ecoCooldown(eco, ECO.CF_CD, db.profiles?.[senderNum]);
    const now = Date.now();
    const elapsed = now - eco.lastCf;
    if (elapsed < cd) {
      return sendText(sock, from, `[ (¬_¬) ] Espera *${fmtCooldown(cd - elapsed)}* antes de volver a lanzar la moneda kashira.`, msg);
    }

    const amount = parseInt((rest || "").replace(/\D/g, ""), 10);
    if (!amount) return sendText(sock, from, `[ x_x ] Usa: #cf [monto] kashira. Mínimo ${fmtM(ECO.BET_MIN)}.`, msg);
    if (amount < ECO.BET_MIN) return sendText(sock, from, `[ x_x ] El monto mínimo es ${fmtM(ECO.BET_MIN)} kashira.`, msg);
    if (amount > eco.wallet) return sendText(sock, from, "[ x_x ] No tienes esa cantidad fuera del banco kashira.", msg);
    const cfBetRoom = getHourlyBetRoom(eco);
    if (amount > cfBetRoom) return sendText(sock, from, `[ x_x ] Ya casi llegas al límite de apuesta por hora kashira. Te quedan *${fmtM(Math.max(cfBetRoom, 0))}* disponibles esta hora.`, msg);
    addHourlyBet(eco, amount);

    // Antes era 50/50; ahora la casa tiene una ligera ventaja (45% de ganar para el jugador).
    const win = !consumeJinx(db, from, senderNum) && Math.random() < goodChanceWithLuck(db, from, senderNum, 0.45);
    eco.wallet += win ? amount : -amount;
    eco.lastCf = now;
    eco.lastActive = now;
    saveDB(db);
    await sock.sendMessage(from, {
      text: win
        ? `*⌞ Coinflip ⌝*\n━━━━━━━━━━━━━━━━\n\n[ (*^.^*) ] ¡La moneda cayó a tu favor kashira! Ganaste *${fmtM(amount)}*.\n\nBolsillo: *${fmtM(eco.wallet)}*\n━━━━━━━━━━━━━━━━`
        : `*⌞ Coinflip ⌝*\n━━━━━━━━━━━━━━━━\n\n[ °﹏° ] La moneda no te favoreció kashira. Perdiste *${fmtM(amount)}*.\n\nBolsillo: *${fmtM(eco.wallet)}*\n━━━━━━━━━━━━━━━━`,
      mentions: [sender]
    }, { quoted: msg });
  }

  else if (finalCmd === "rt") {
    const eco = getEco(db, from, senderNum);
    const cd = ecoCooldown(eco, ECO.RT_CD, db.profiles?.[senderNum]);
    const now = Date.now();
    const elapsed = now - eco.lastRt;
    if (elapsed < cd) {
      return sendText(sock, from, `[ (¬_¬) ] Espera *${fmtCooldown(cd - elapsed)}* antes de volver a girar la ruleta kashira.`, msg);
    }

    const parts = (rest || "").trim().split(/\s+/).filter(Boolean);
    let amount = null, color = null;
    for (const p of parts) {
      if (/^\d+$/.test(p)) amount = parseInt(p, 10);
      else if (["rojo", "red"].includes(p.toLowerCase())) color = "rojo";
      else if (["negro", "black"].includes(p.toLowerCase())) color = "negro";
    }
    if (!amount || !color) return sendText(sock, from, `[ x_x ] Usa: #rt [monto] [rojo|negro] kashira. Mínimo ${fmtM(ECO.BET_MIN)}.`, msg);
    if (amount < ECO.BET_MIN) return sendText(sock, from, `[ x_x ] El monto mínimo es ${fmtM(ECO.BET_MIN)} kashira.`, msg);

    if (amount > eco.wallet) return sendText(sock, from, "[ x_x ] No tienes esa cantidad fuera del banco kashira.", msg);
    const rtBetRoom = getHourlyBetRoom(eco);
    if (amount > rtBetRoom) return sendText(sock, from, `[ x_x ] Ya casi llegas al límite de apuesta por hora kashira. Te quedan *${fmtM(Math.max(rtBetRoom, 0))}* disponibles esta hora.`, msg);
    addHourlyBet(eco, amount);

    // Antes era 50/50 exacto; ahora hay un 8% de chance de que salga "verde" (gana la casa
    // sin importar el color elegido), bajando la probabilidad real de ganar del jugador.
    const jinxed = consumeJinx(db, from, senderNum);
    const luckOverride = getEffectiveLuckGoodChance(db, from, senderNum);
    let result;
    if (luckOverride !== null) {
      result = Math.random() < luckOverride ? color : (color === "rojo" ? "negro" : "rojo");
    } else {
      const roll = Math.random();
      result = roll < 0.08 ? "verde" : (roll < 0.54 ? "rojo" : "negro");
    }
    if (jinxed && result === color) result = color === "rojo" ? "negro" : "rojo";
    const win = result === color;
    eco.wallet += win ? amount : -amount;
    eco.lastRt = now;
    eco.lastActive = now;
    saveDB(db);
    await sock.sendMessage(from, {
      text: `*⌞ Ruleta ⌝*\n━━━━━━━━━━━━━━━━\n\n[ (¬‿¬) ] Salió *${result}* kashira, apostaste a *${color}*.\n\n${win ? `(*^.^*) ¡Ganaste *${fmtM(amount)}*!` : `(x_x) Perdiste *${fmtM(amount)}*.`}\n\nBolsillo: *${fmtM(eco.wallet)}*\n━━━━━━━━━━━━━━━━`,
      mentions: [sender]
    }, { quoted: msg });
  }

  else if (finalCmd === "slots") {
    const eco = getEco(db, from, senderNum);
    const cd = ecoCooldown(eco, ECO.SLOTS_CD, db.profiles?.[senderNum]);
    const now = Date.now();
    const elapsed = now - eco.lastSlots;
    if (elapsed < cd) {
      return sendText(sock, from, `[ (¬_¬) ] Espera *${fmtCooldown(cd - elapsed)}* antes de volver a tirar de la palanca kashira.`, msg);
    }

    const amount = parseInt((rest || "").replace(/\D/g, ""), 10);
    if (!amount) return sendText(sock, from, `[ x_x ] Usa: #slots [monto] kashira. Mínimo ${fmtM(ECO.BET_MIN)}.`, msg);
    if (amount < ECO.BET_MIN) return sendText(sock, from, `[ x_x ] El monto mínimo es ${fmtM(ECO.BET_MIN)} kashira.`, msg);
    if (amount > eco.wallet) return sendText(sock, from, "[ x_x ] No tienes esa cantidad fuera del banco kashira.", msg);
    const slotsBetRoom = getHourlyBetRoom(eco);
    if (amount > slotsBetRoom) return sendText(sock, from, `[ x_x ] Ya casi llegas al límite de apuesta por hora kashira. Te quedan *${fmtM(Math.max(slotsBetRoom, 0))}* disponibles esta hora.`, msg);
    addHourlyBet(eco, amount);

    let s1 = pickSlotSymbol(), s2 = pickSlotSymbol(), s3 = pickSlotSymbol();
    const jinxed = consumeJinx(db, from, senderNum);
    const slotsLuck = getEffectiveLuckGoodChance(db, from, senderNum);
    if (jinxed) {
      // Re-tira hasta que no haya ninguna coincidencia, para que la derrota forzada
      // se vea coherente con los símbolos mostrados (y no un "perdiste" con triple igual).
      do { s1 = pickSlotSymbol(); s2 = pickSlotSymbol(); s3 = pickSlotSymbol(); }
      while (s1 === s2 || s2 === s3 || s1 === s3);
    } else if (slotsLuck !== null) {
      const forceWin = Math.random() < slotsLuck;
      do { s1 = pickSlotSymbol(); s2 = pickSlotSymbol(); s3 = pickSlotSymbol(); }
      while (forceWin ? !(s1 === s2 || s2 === s3 || s1 === s3) : (s1 === s2 || s2 === s3 || s1 === s3));
    }
    const reel = `[ ${s1} | ${s2} | ${s3} ]`;

    // Antes "doble" (cualquier par de las 3 coincide) pagaba x2 con ~40% de probabilidad,
    // lo que dejaba el juego con EV POSITIVO para el jugador (+33% por apuesta). Ahora paga
    // x1 (recuperas tu apuesta + la misma cantidad de ganancia, no el doble), quedando la
    // casa con una ligera ventaja similar a #cf y #rt (~-7% por apuesta).
    let multiplier = 0;
    let resultLabel = "Derrota";
    if (s1 === s2 && s2 === s3 && s1 === "7") {
      multiplier = ECO.SLOTS_JACKPOT_MULT;
      resultLabel = "¡JACKPOT!";
    } else if (s1 === s2 && s2 === s3) {
      multiplier = ECO.SLOTS_TRIPLE_MULT;
      resultLabel = "Premio x3";
    } else if (s1 === s2 || s2 === s3 || s1 === s3) {
      multiplier = ECO.SLOTS_DOUBLE_MULT;
      resultLabel = "Premio x1";
    }

    const win = multiplier > 0;
    const change = win ? amount * multiplier : -amount;
    eco.wallet += change;
    eco.lastSlots = now;
    eco.lastActive = now;
    saveDB(db);

    const kao = multiplier >= ECO.SLOTS_JACKPOT_MULT ? "(((*°▽°*)))" : win ? "(*^.^*)" : "(x_x)";
    await sock.sendMessage(from, {
      text: `*⌞ Tragamonedas ⌝*\n━━━━━━━━━━━━━━━━\n\n${reel}\n\n${kao} *${resultLabel}*${win ? ` — ¡Ganaste *${fmtM(change)}*!` : ` — Perdiste *${fmtM(amount)}*.`}\n\nBolsillo: *${fmtM(eco.wallet)}*\n━━━━━━━━━━━━━━━━`,
      mentions: [sender]
    }, { quoted: msg });
  }

  else if (finalCmd === "dice") {
    const eco = getEco(db, from, senderNum);
    const cd = ecoCooldown(eco, ECO.DICE_CD, db.profiles?.[senderNum]);
    const now = Date.now();
    const elapsed = now - eco.lastDice;
    if (elapsed < cd) {
      return sendText(sock, from, `[ (¬_¬) ] Espera *${fmtCooldown(cd - elapsed)}* antes de volver a tirar los dados kashira.`, msg);
    }

    const amount = parseInt((rest || "").replace(/\D/g, ""), 10);
    if (!amount) return sendText(sock, from, `[ x_x ] Usa: #dice [monto] kashira. Mínimo ${fmtM(ECO.BET_MIN)}.`, msg);
    if (amount < ECO.BET_MIN) return sendText(sock, from, `[ x_x ] El monto mínimo es ${fmtM(ECO.BET_MIN)} kashira.`, msg);
    if (amount > eco.wallet) return sendText(sock, from, "[ x_x ] No tienes esa cantidad fuera del banco kashira.", msg);
    const diceBetRoom = getHourlyBetRoom(eco);
    if (amount > diceBetRoom) return sendText(sock, from, `[ x_x ] Ya casi llegas al límite de apuesta por hora kashira. Te quedan *${fmtM(Math.max(diceBetRoom, 0))}* disponibles esta hora.`, msg);
    addHourlyBet(eco, amount);

    const jinxed = consumeJinx(db, from, senderNum);
    const diceLuck = getEffectiveLuckGoodChance(db, from, senderNum);
    // Antes Beatrice tiraba un solo dado (empate a empate real ~41.6% de ganar cada quien);
    // ahora tira dos y se queda con el mayor, bajando la probabilidad de que el jugador gane.
    let botRoll = Math.max(randInt(1, 6), randInt(1, 6));
    let playerRoll = randInt(1, 6);
    if (jinxed) {
      // Fuerza una derrota real y siempre válida: Beatrice saca el máximo posible y
      // el dado del jugador se recalcula para quedar siempre por debajo (1-5 < 6).
      botRoll = 6;
      playerRoll = randInt(1, 5);
    } else if (diceLuck !== null) {
      const forceWin = Math.random() < diceLuck;
      if (forceWin) {
        playerRoll = 6;
        botRoll = randInt(1, 5);
      } else {
        botRoll = 6;
        playerRoll = randInt(1, 5);
      }
    }
    eco.lastDice = now;
    eco.lastActive = now;

    let change, resultText, diceWin = false;
    if (playerRoll > botRoll) {
      change = amount;
      eco.wallet += change;
      resultText = `(*^.^*) ¡Ganaste *${fmtM(change)}*!`;
      diceWin = true;
    } else if (playerRoll < botRoll) {
      change = -amount;
      eco.wallet += change;
      resultText = `(x_x) Perdiste *${fmtM(amount)}*.`;
    } else {
      change = 0;
      resultText = "(・_・) Empate kashira, tu apuesta fue devuelta.";
    }
    saveDB(db);

    await sock.sendMessage(from, {
      text: `*⌞ Dados ⌝*\n━━━━━━━━━━━━━━━━\n\n(p^.^q) Tú: *${playerRoll}*\n(o^-')b Beatrice: *${botRoll}*\n\n${resultText}\n\nBolsillo: *${fmtM(eco.wallet)}*\n━━━━━━━━━━━━━━━━`,
      mentions: [sender]
    }, { quoted: msg });
  }

  else if (finalCmd === "nick") {
    const NICK_USAGE = "[ x_x ] Usa: #nick @usuario [apodo]  o  #nick [apodo] @usuario kashira.\n\nEl apodo solo puede tener letras normales (sin números, tildes, ñ ni símbolos), entre 2 y 20.\n\nEs LOCAL: solo tú podrás usarlo para referirte a esa persona en comandos como #pay.";

    const target = resolveToPN(getMentionedJid(msg));
    if (!target) return sendText(sock, from, NICK_USAGE, msg);
    const targetNum = findProfileNum(db, target) || target.split("@")[0].split(":")[0];
    if (targetNum === senderNum) return sendText(sock, from, "[ x_x ] No puedes ponerte un apodo a ti mismo/a kashira.", msg);
    if (!db.profiles?.[senderNum]) return sendText(sock, from, "[ x_x ] Primero crea tu perfil con #createprofile kashira.", msg);
    if (!db.profiles?.[targetNum]) {
      return sock.sendMessage(from, { text: `[ x_x ] @${targetNum} no tiene perfil kashira, no puedes ponerle un apodo hasta que use #createprofile.`, mentions: [target] }, { quoted: msg });
    }

    const nickArg = stripMentionText(msg, rest).trim();
    if (!nickArg) return sendText(sock, from, NICK_USAGE, msg);

    // "off"/"quitar"/"borrar" → elimina el apodo que le tenías puesto a esa persona.
    if (["off", "quitar", "borrar", "delete"].includes(normalizeText(nickArg))) {
      removeNickname(db, senderNum, targetNum);
      saveDB(db);
      return await sock.sendMessage(from, { text: `[ (¬‿¬) ] Se quitó el apodo que tenías puesto para @${targetNum} kashira.`, mentions: [target] }, { quoted: msg });
    }

    if (!/^[A-Za-z]+$/.test(nickArg)) {
      return sendText(sock, from, "[ x_x ] El apodo solo puede tener letras normales kashira (sin números, tildes, ñ ni símbolos).", msg);
    }
    if (nickArg.length < 2 || nickArg.length > 20) {
      return sendText(sock, from, "[ x_x ] El apodo debe tener entre 2 y 20 letras kashira.", msg);
    }
    if (NICK_RESERVED_WORDS.includes(normalizeText(nickArg))) {
      return sendText(sock, from, "[ x_x ] Ese apodo está reservado kashira, usa otro.", msg);
    }

    const clashTarget = findNickOwnerTarget(db, senderNum, nickArg);
    if (clashTarget && clashTarget !== targetNum) {
      return sock.sendMessage(from, { text: `[ x_x ] Ya usas ese apodo para @${clashTarget} kashira, quítaselo primero con #nick @${clashTarget} off.`, mentions: [clashTarget + "@s.whatsapp.net"] }, { quoted: msg });
    }

    setNickname(db, senderNum, targetNum, nickArg);
    saveDB(db);
    await sock.sendMessage(from, { text: `[ (¬‿¬) ] Listo kashira, ahora puedes referirte a @${targetNum} como *${nickArg}* en comandos como #pay.`, mentions: [target] }, { quoted: msg });
  }

  else if (finalCmd === "nicks") {
    const impuestos = [];
    for (const [otherNum, map] of Object.entries(db.nicknames || {})) {
      if (otherNum === senderNum) continue;
      const nick = map?.[senderNum];
      if (nick) impuestos.push({ nick, name: db.profiles?.[otherNum]?.name || `Usuario sin perfil (${otherNum})` });
    }

    const puestos = [];
    for (const [targetNum, nick] of Object.entries(db.nicknames?.[senderNum] || {})) {
      puestos.push({ nick, name: db.profiles?.[targetNum]?.name || `Usuario sin perfil (${targetNum})` });
    }

    if (!impuestos.length && !puestos.length) {
      return sendText(sock, from, "[ (._.) ] No tienes apodos puestos ni te han puesto ninguno kashira. Usa #nick @usuario [apodo].", msg);
    }

    const impuestosTxt = impuestos.length ? impuestos.map(e => `${e.nick} - ${e.name}`).join("\n") : "_Nadie te ha puesto un apodo kashira._";
    const puestosTxt = puestos.length ? puestos.map(e => `${e.nick} - ${e.name}`).join("\n") : "_No le has puesto apodo a nadie kashira._";

    await sendText(sock, from, `*⌞ Tus apodos ⌝*\n━━━━━━━━━━━━━━━━\n\n*Apodos impuestos:*\n${impuestosTxt}\n\n*Apodos puestos:*\n${puestosTxt}\n━━━━━━━━━━━━━━━━`, msg);
  }

  else if (finalCmd === "pay") {
    let target = resolveToPN(getMentionedJid(msg));
    let targetNum = target ? (findProfileNum(db, target) || target.split("@")[0].split(":")[0]) : null;
    if (!targetNum) targetNum = resolveNicknameInText(db, senderNum, rest);
    if (!targetNum) return sendText(sock, from, `[ x_x ] Usa: #pay [monto] @usuario  o  #pay @usuario [monto] kashira (también acepta apodos puestos con #nick). Mínimo ${fmtM(ECO.PAY_MIN)}.`, msg);
    target = target || (targetNum + "@s.whatsapp.net");
    if (targetNum === senderNum) return sendText(sock, from, "[ x_x ] No puedes pagarte a ti mismo/a kashira.", msg);
    if (!db.profiles?.[targetNum]) {
      return sock.sendMessage(from, { text: `[ x_x ] @${targetNum} no tiene perfil kashira, no puede recibir dinero hasta que use #createprofile.`, mentions: [target] }, { quoted: msg });
    }

    const cleanRest = stripMentionText(msg, rest);
    const amtMatch = cleanRest.match(/\d+/);
    const amount = amtMatch ? parseInt(amtMatch[0], 10) : NaN;
    if (!amount) return sendText(sock, from, `[ x_x ] Usa: #pay [monto] @usuario  o  #pay @usuario [monto] kashira. Mínimo ${fmtM(ECO.PAY_MIN)}.`, msg);
    if (amount < ECO.PAY_MIN) return sendText(sock, from, `[ x_x ] El monto mínimo para transferir es ${fmtM(ECO.PAY_MIN)} kashira.`, msg);

    const eco = getEco(db, from, senderNum);
    if (amount > eco.bank) return sendText(sock, from, "[ x_x ] No tienes esa cantidad en el banco kashira.", msg);

    const targetEco = getEco(db, from, targetNum);
    eco.bank -= amount;
    targetEco.bank += amount;
    eco.lastActive = Date.now();
    saveDB(db);
    const balanceLine = amount >= 20000 ? `\n(o^.^o) Te quedan *${fmtM(eco.bank)}* en el banco.` : "";
    await sock.sendMessage(from, {
      text: `*⌞ Transferencia ⌝*\n━━━━━━━━━━━━━━━━\n\n[ (o^-')b ] @${senderNum} le transfirió *${fmtM(amount)}* a @${targetNum} desde el banco kashira.${balanceLine}\n━━━━━━━━━━━━━━━━`,
      mentions: [sender, target]
    }, { quoted: msg });
  }

  else if (finalCmd === "top") {
    const sub = normalizeText(args[1] || "");
    const isGlobalScope = normalizeText(args[2] || "") === "global";

    if (["mensajes", "mensaje", "msgs", "msg"].includes(sub)) {
      if (isGlobalScope) {
        // Un solo lugar por perfil: se toma el grupo donde esa persona tiene MÁS mensajes,
        // y se muestra cuál es ese grupo (así nadie aparece repetido varias veces).
        const best = {};
        for (const [num, prof] of Object.entries(db.profiles || {})) {
          const gs = prof.groupStats || {};
          let bestGid = null, bestMsgs = 0, bestCmds = 0;
          for (const [gid, s] of Object.entries(gs)) {
            if ((s.msgs || 0) > bestMsgs) { bestMsgs = s.msgs || 0; bestCmds = s.cmds || 0; bestGid = gid; }
          }
          if (bestGid && bestMsgs > 0) best[num] = { msgs: bestMsgs, cmds: bestCmds, gid: bestGid };
        }
        const ranked = Object.entries(best).map(([num, v]) => ({ num, ...v })).sort((a, b) => b.msgs - a.msgs).slice(0, 10);
        if (!ranked.length) return sendText(sock, from, "[ (._.) ] Todavía no hay mensajes registrados en ningún grupo kashira.", msg);

        const lines = [];
        for (let i = 0; i < ranked.length; i++) {
          const e = ranked[i];
          const name = db.profiles?.[e.num]?.name || `Usuario sin perfil (${e.num})`;
          const gname = await getGroupName(sock, db, e.gid);
          lines.push(`*${i + 1}-* *${name}*\n   (o^-')b ${e.msgs.toLocaleString("es-MX")} mensajes, ${e.cmds.toLocaleString("es-MX")} comandos — Grupo: ${gname}`);
        }
        return sendText(sock, from, `*⌞ Top Mensajes Global ⌝*\n━━━━━━━━━━━━━━━━\n\n${lines.join("\n\n")}\n\n━━━━━━━━━━━━━━━━`, msg);
      }

      if (!isGroup) return sendText(sock, from, "[ x_x ] Usa *#top mensajes* dentro de un grupo, o *#top mensajes global* desde donde sea kashira.", msg);
      const meta = await sock.groupMetadata(from).catch(() => null);
      if (!meta) return sendText(sock, from, "[ x_x ] No pude obtener la información del grupo kashira.", msg);
      updateLidMapFromMeta(meta);
      const nums = [...new Set(meta.participants.map(p => resolveToPN(p.id).split("@")[0].split(":")[0]))];
      const entries = nums
        .filter(n => db.profiles?.[n]?.groupStats?.[from]?.msgs)
        .map(n => ({ num: n, msgs: db.profiles[n].groupStats[from].msgs, cmds: db.profiles[n].groupStats[from].cmds || 0 }))
        .sort((a, b) => b.msgs - a.msgs)
        .slice(0, 5);
      if (!entries.length) return sendText(sock, from, "[ (._.) ] Nadie en este grupo tiene mensajes registrados todavía kashira.", msg);

      const lines = entries.map((e, i) => `*#${i + 1}* @${e.num} — *${e.msgs.toLocaleString("es-MX")} mensajes*, ${e.cmds.toLocaleString("es-MX")} comandos`).join("\n");
      return sock.sendMessage(from, {
        text: `*⌞ Top Mensajes del Grupo ⌝*\n━━━━━━━━━━━━━━━━\n\n${lines}\n\n━━━━━━━━━━━━━━━━`,
        mentions: entries.map(e => e.num + "@s.whatsapp.net")
      }, { quoted: msg });
    }

    if (["coins", "monedas", "economia", "eco"].includes(sub)) {
      if (isGlobalScope) {
        // Igual que mensajes global: un solo lugar por perfil (su grupo con más fortuna),
        // mostrando usuario, fortuna y el grupo donde la tiene.
        const best = {};
        for (const [gid, groupEco] of Object.entries(db.economy || {})) {
          if (!gid.endsWith("@g.us") || !groupEco || typeof groupEco !== "object") continue;
          for (const [num, eco] of Object.entries(groupEco)) {
            if (!eco || typeof eco !== "object") continue;
            const amount = (eco.wallet || 0) + (eco.bank || 0);
            if (amount <= 0) continue;
            if (!best[num] || amount > best[num].amount) best[num] = { amount, gid };
          }
        }
        const ranked = Object.entries(best).map(([num, v]) => ({ num, ...v })).sort((a, b) => b.amount - a.amount).slice(0, 10);
        if (!ranked.length) return sendText(sock, from, "[ (._.) ] Todavía no hay economía activa en ningún grupo kashira.", msg);

        const lines = [];
        for (let i = 0; i < ranked.length; i++) {
          const e = ranked[i];
          const name = db.profiles?.[e.num]?.name || `Usuario sin perfil (${e.num})`;
          const gname = await getGroupName(sock, db, e.gid);
          lines.push(`*${i + 1}-* *${name}*\n   (o^-')b Fortuna: ${fmtM(e.amount)} — Grupo: ${gname}`);
        }
        return sendText(sock, from, `*⌞ Top Coins Global ⌝*\n━━━━━━━━━━━━━━━━\n\n${lines.join("\n\n")}\n\n━━━━━━━━━━━━━━━━`, msg);
      }

      if (!isGroup) return sendText(sock, from, "[ x_x ] Usa *#top coins* dentro de un grupo, o *#top coins global* desde donde sea kashira.", msg);
      const groupEco = db.economy?.[from] || {};
      const entries = Object.entries(groupEco)
        .filter(([, eco]) => eco && typeof eco === "object")
        .map(([num, eco]) => ({ num, total: (eco.wallet || 0) + (eco.bank || 0) }))
        .filter(e => e.total > 0)
        .sort((a, b) => b.total - a.total)
        .slice(0, 5);
      if (!entries.length) return sendText(sock, from, "[ (._.) ] Nadie en este grupo tiene economía activa todavía kashira.", msg);

      const lines = entries.map((e, i) => `*#${i + 1}* @${e.num} — *${fmtM(e.total)}*`).join("\n");
      return sock.sendMessage(from, {
        text: `*⌞ Top Coins del Grupo ⌝*\n━━━━━━━━━━━━━━━━\n\n${lines}\n\n━━━━━━━━━━━━━━━━`,
        mentions: entries.map(e => e.num + "@s.whatsapp.net")
      }, { quoted: msg });
    }

    if (["level", "nivel", "lvl"].includes(sub)) {
      // Siempre global: el nivel/XP no es algo que exista "por grupo".
      const ranked = Object.entries(db.profiles || {})
        .map(([num, p]) => ({ num, level: p.level || 1, xp: p.xp || 0 }))
        .sort((a, b) => b.level - a.level || b.xp - a.xp)
        .slice(0, 10);
      if (!ranked.length) return sendText(sock, from, "[ (._.) ] Todavía no hay perfiles creados kashira.", msg);

      const lines = ranked.map((e, i) => {
        const name = db.profiles?.[e.num]?.name || `Usuario sin perfil (${e.num})`;
        return `*${i + 1}-* *${name}* — Nivel ${e.level} (${e.xp.toLocaleString("es-MX")} XP)`;
      }).join("\n\n");
      return sendText(sock, from, `*⌞ Top Nivel (Global) ⌝*\n━━━━━━━━━━━━━━━━\n\n${lines}\n\n━━━━━━━━━━━━━━━━`, msg);
    }

    return sendText(sock, from, "[ x_x ] Usa: *#top mensajes*, *#top mensajes global*, *#top coins*, *#top coins global* o *#top level* kashira.", msg);
  }

  else if (finalCmd === "shop") {
    const sub = normalizeText(args[1]);
    const animeQuery = args.slice(2).join(" ");

    // Marca en la lista si ya lo tienes o si no te alcanza el dinero, para no tener que
    // ir y venir a #bal o #inv mientras decides qué comprar.
    const shopMarkers = ({ owned, affordable }) => {
      const tags = [];
      if (owned) tags.push("ya lo tienes");
      if (!affordable) tags.push("no te alcanza");
      return tags.length ? ` _(${tags.join(", ")})_` : "";
    };

    if (!sub) {
      const animes = [...new Set(SHOP_ITEMS.map(i => i.anime))];
      const text =
        `*⌞ Tienda ⌝*\n━━━━━━━━━━━━━━━━\n\n` +
        `(o^-')b *#shop titulos* — ver títulos\n` +
        `(p^.^q) *#shop ventajas* — ver ventajas\n` +
        `(¥_¥) *#shop banco* — ver mejoras de tope de banco\n` +
        `(*^.^*) *#shop objetos [anime]* — ver objetos de un anime\n` +
        `(⌐■_■) *#shop buscar [texto]* — buscar en toda la tienda a la vez\n\n` +
        `*Animes disponibles:*\n${animes.map(a => `• ${a}`).join("\n")}\n\n` +
        `Compra con *#buy [nombre]* o *#comprar [nombre]* kashira.\n` +
        `¿Quieres un título único? Usa *#customtitle [texto]* kashira.\n━━━━━━━━━━━━━━━━`;
      await sendText(sock, from, text, msg);

    } else if (sub === "titulos" || sub === "titles") {
      const inv = getInv(db, senderNum);
      const eco = getEco(db, from, senderNum);
      const lines = SHOP_TITLES.map((t, i) => {
        const owned = inv.titles.includes(t.id);
        const affordable = eco.bank >= t.price;
        return `*${i + 1}.* ${t.name} — ${fmtM(t.price)}${shopMarkers({ owned, affordable })}`;
      }).join("\n");
      db.shopView = db.shopView || {};
      db.shopView[senderNum] = { ids: SHOP_TITLES.map(t => t.id), ts: Date.now() };
      saveDB(db);
      await sendText(
        sock, from,
        `*⌞ Tienda: Títulos ⌝*\n━━━━━━━━━━━━━━━━\n\n${lines}\n\n` +
        `Compra con *#buy [número]* o *#buy [nombre]* kashira.\n\n` +
        `(máx. 1 título equipado, se equipa solo si no tienes uno puesto)\n━━━━━━━━━━━━━━━━`,
        msg
      );

    } else if (sub === "perks" || sub === "ventajas" || sub === "advantages") {
      const eco = getEco(db, from, senderNum);
      const lines = SHOP_ADVANTAGES.map((a, i) => {
        const owned = !!eco.advantages[a.id];
        const affordable = eco.bank >= a.price;
        return `*${i + 1}.* ${a.name} — ${fmtM(a.price)}${shopMarkers({ owned, affordable })}\n  _${a.desc}_`;
      }).join("\n\n");
      db.shopView = db.shopView || {};
      db.shopView[senderNum] = { ids: SHOP_ADVANTAGES.map(a => a.id), ts: Date.now() };
      saveDB(db);
      await sendText(sock, from, `*⌞ Tienda: Ventajas ⌝*\n━━━━━━━━━━━━━━━━\n\n${lines}\n\nCompra con *#buy [número]* o *#buy [nombre]* kashira.\n(se aplican de inmediato, no van al inventario)\n━━━━━━━━━━━━━━━━`, msg);

    } else if (sub === "banco" || sub === "bank") {
      const eco = getEco(db, from, senderNum);
      const currentCap = getBankCap(eco);
      const lines = BANK_UPGRADES.map((b, i) => {
        const owned = (eco.bankTier || 0) >= (i + 1);
        const affordable = eco.bank >= b.price;
        return `*${i + 1}.* ${b.name} — ${fmtM(b.price)} _(tope: ${fmtM(b.cap)})_${shopMarkers({ owned, affordable })}`;
      }).join("\n");
      db.shopView = db.shopView || {};
      db.shopView[senderNum] = { ids: BANK_UPGRADES.map(b => b.id), ts: Date.now() };
      saveDB(db);
      await sendText(sock, from, `*⌞ Tienda: Banco ⌝*\n━━━━━━━━━━━━━━━━\n\nTu tope actual: *${fmtM(currentCap)}*\n\n${lines}\n\nCompra con *#buy [número]* o *#buy [nombre]* kashira.\n(cada nivel reemplaza al anterior, cómpralos en orden)\n━━━━━━━━━━━━━━━━`, msg);

    } else if (sub === "objetos" || sub === "items") {
      if (!animeQuery) {
        const animes = [...new Set(SHOP_ITEMS.map(i => i.anime))];
        return sendText(sock, from, `*⌞ Tienda: Objetos ⌝*\n━━━━━━━━━━━━━━━━\n\nUsa *#shop objetos [anime]* kashira.\n\n${animes.map(a => `• ${a}`).join("\n")}\n━━━━━━━━━━━━━━━━`, msg);
      }
      const found = findAnimeItems(animeQuery);
      if (!found) return sendText(sock, from, "[ x_x ] No encontré ese anime en la tienda kashira.", msg);
      const inv = getInv(db, senderNum);
      const eco = getEco(db, from, senderNum);
      const lines = found.items.map((i, idx) => {
        const owned = inv.items.includes(i.id);
        const affordable = eco.bank >= i.price;
        return `*${idx + 1}.* ${i.name} — ${fmtM(i.price)}${shopMarkers({ owned, affordable })}`;
      }).join("\n");
      db.shopView = db.shopView || {};
      db.shopView[senderNum] = { ids: found.items.map(i => i.id), ts: Date.now() };
      saveDB(db);
      await sendText(sock, from, `*⌞ Tienda: ${found.anime} ⌝*\n━━━━━━━━━━━━━━━━\n\n${lines}\n\nCompra con *#buy [número]* o *#buy [nombre]* kashira.\n(máx. 3 objetos equipados, sin límite en inventario)\n━━━━━━━━━━━━━━━━`, msg);

    } else if (sub === "buscar" || sub === "search") {
      const query = args.slice(2).join(" ").trim();
      if (!query) return sendText(sock, from, "[ x_x ] Usa: #shop buscar [texto] kashira.", msg);
      const q = normalizeText(query);
      const inv = getInv(db, senderNum);
      const eco = getEco(db, from, senderNum);

      const titleMatches = SHOP_TITLES.filter(t => normalizeText(t.name).includes(q)).map(t => ({ ...t, type: "title" }));
      const advMatches = SHOP_ADVANTAGES.filter(a => normalizeText(a.name).includes(q)).map(a => ({ ...a, type: "advantage" }));
      const bankMatches = BANK_UPGRADES.filter(b => normalizeText(b.name).includes(q)).map(b => ({ ...b, type: "bank" }));
      const itemMatches = SHOP_ITEMS.filter(i => normalizeText(i.name).includes(q) || normalizeText(i.anime).includes(q)).map(i => ({ ...i, type: "item" }));
      const results = [...titleMatches, ...advMatches, ...bankMatches, ...itemMatches];

      if (!results.length) return sendText(sock, from, `[ x_x ] No encontré nada parecido a *${query}* en la tienda kashira.`, msg);

      db.shopView = db.shopView || {};
      db.shopView[senderNum] = { ids: results.map(r => r.id), ts: Date.now() };
      saveDB(db);

      const lines = results.map((r, i) => {
        const typeLabel = r.type === "title" ? "Título" : r.type === "advantage" ? "Ventaja" : r.type === "bank" ? "Banco" : `Objeto, ${r.anime}`;
        const owned = r.type === "title" ? inv.titles.includes(r.id) : r.type === "advantage" ? !!eco.advantages[r.id] : r.type === "bank" ? (eco.bankTier || 0) >= BANK_UPGRADES.findIndex(b => b.id === r.id) + 1 : inv.items.includes(r.id);
        const affordable = eco.bank >= r.price;
        return `*${i + 1}.* ${r.name} — ${fmtM(r.price)} _(${typeLabel})_${shopMarkers({ owned, affordable })}`;
      }).join("\n");

      await sendText(sock, from, `*⌞ Tienda: resultados de "${query}" ⌝*\n━━━━━━━━━━━━━━━━\n\n${lines}\n\nCompra con *#buy [número]* o *#buy [nombre]* kashira.\n━━━━━━━━━━━━━━━━`, msg);

    } else {
      await sendText(sock, from, "[ x_x ] Usa: #shop, #shop titulos, #shop ventajas, #shop banco o #shop objetos [anime] kashira.", msg);
    }
  }

  else if (finalCmd === "buy") {
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #buy [nombre] o #buy [número] (después de ver #shop) kashira.", msg);

    const buyRest = rest.trim();

    // ── Llave de mina: #buy llave [zona] ──
    const mineKeyMatch = normalizeText(buyRest).match(/^llave\s+(\d+)$/);
    if (mineKeyMatch) {
      const zoneId = parseInt(mineKeyMatch[1], 10);
      const zone = findZone("pico", zoneId);
      if (!zone) return sendText(sock, from, "[ x_x ] Esa zona de minería no existe kashira. Usa un número del 1 al 5.", msg);
      const eco = getEco(db, from, senderNum);
      const g = getGather(eco);
      if (eco.bank < zone.keyPrice) return sendText(sock, from, `[ x_x ] Te falta dinero en el banco kashira. Necesitas ${fmtM(zone.keyPrice)}.`, msg);
      eco.bank -= zone.keyPrice;
      g.mineKeys[zoneId] = (g.mineKeys[zoneId] || 0) + 1;

      let chestBonus = "";
      const pending = g.pendingChest;
      if (pending && pending.kind === "pico" && pending.zoneId === zoneId && pending.expiresAt > Date.now()) {
        g.pendingChest = null;
        g.mineKeys[zoneId] -= 1;
        if (g.mineKeys[zoneId] <= 0) delete g.mineKeys[zoneId];
        chestBonus = openChestReward(eco, g, zone);
      }

      saveDB(db);
      return sendText(sock, from, `[ (*^.^*) ] Compraste una llave para *${zone.name}* kashira.${chestBonus}`, msg);
    }

    // ── Pico / Caña: #buy pico [cantidad] | #buy pico pro [cantidad] | #buy caña dios [cantidad] ──
    const toolReq = matchToolArgs(buyRest);
    if (toolReq) {
      const eco = getEco(db, from, senderNum);
      const g = getGather(eco);
      const { kind, level, qty } = toolReq;
      let bought = 0, failed = 0, stoppedShort = false;

      for (let i = 0; i < qty; i++) {
        if (level === 1) {
          if (eco.bank < GATHER.TOOL1_PRICE) { stoppedShort = true; break; }
          eco.bank -= GATHER.TOOL1_PRICE;
          const uses = eco.advantages?.durabilidad ? GATHER.TOOL1_USES * 2 : GATHER.TOOL1_USES;
          toolList(g, kind).push({ level: 1, usesLeft: uses });
          bought++;
        } else {
          const req = TOOL_CRAFT[kind][level];
          const missingMat = Object.entries(req.materials).find(([id, need]) => (g.materials[id] || 0) < need);
          if (eco.bank < req.money || missingMat) { stoppedShort = true; break; }
          eco.bank -= req.money;
          for (const [id, need] of Object.entries(req.materials)) {
            g.materials[id] -= need;
            if (g.materials[id] <= 0) delete g.materials[id];
          }
          const failChance = eco.advantages?.maestria ? req.fail / 2 : req.fail;
          if (Math.random() < failChance) {
            failed++;
            continue;
          }
          const uses = eco.advantages?.durabilidad ? req.uses * 2 : req.uses;
          toolList(g, kind).push({ level, usesLeft: uses });
          bought++;
        }
      }

      autoEquipBest(g, kind);
      saveDB(db);

      const label = toolName(kind, level);
      if (bought === 0 && failed === 0) {
        const priceInfo = level === 1
          ? `Necesitas ${fmtM(GATHER.TOOL1_PRICE)} en el banco.`
          : `Necesitas ${fmtM(TOOL_CRAFT[kind][level].money)} y los materiales: ${Object.entries(TOOL_CRAFT[kind][level].materials).map(([id, need]) => `${need}x ${materialName(id)}`).join(", ")}.`;
        return sendText(sock, from, `[ x_x ] No te alcanza para craftear/comprar *${label}* kashira. ${priceInfo}`, msg);
      }

      let text = `[ (*^.^*) ] `;
      if (bought > 0) text += `Conseguiste *${bought}x ${label}* kashira. `;
      if (failed > 0) text += `El crafteo falló *${failed}* vez(es) (se perdieron los recursos igual). `;
      if (stoppedShort) text += `Te quedaste sin dinero/materiales para seguir craftando más.`;
      const eq = getEquippedTool(g, kind);
      if (eq) text += `\n\nAhora tienes equipado: *${toolName(kind, eq.tool.level)}* (${eq.tool.usesLeft} usos).`;
      return await sendText(sock, from, text.trim(), msg);
    }

    let entry = null;
    if (/^\d+$/.test(rest.trim())) {
      const idx = parseInt(rest.trim(), 10) - 1;
      const view = db.shopView?.[senderNum];
      if (!view || Date.now() - view.ts > 10 * 60 * 1000) {
        return sendText(sock, from, "[ x_x ] Primero revisa #shop titulos, #shop ventajas o #shop objetos [anime] para usar números kashira.", msg);
      }
      const id = view.ids[idx];
      if (!id) return sendText(sock, from, "[ x_x ] Ese número no existe en la última lista que viste kashira.", msg);
      entry = findShopEntryById(id);
    } else {
      entry = findShopEntry(rest);
    }
    if (!entry) return sendText(sock, from, "[ x_x ] No encontré eso en la tienda kashira. Revisa #shop.", msg);

    const eco = getEco(db, from, senderNum);
    const inv = getInv(db, senderNum);

    if (entry.type === "title") {
      if (inv.titles.includes(entry.id)) return sendText(sock, from, "[ (¬_¬) ] Ya tienes ese título kashira.", msg);
      if (eco.bank < entry.price) return sendText(sock, from, `[ x_x ] Te falta dinero en el banco de este grupo kashira. Necesitas ${fmtM(entry.price)}.`, msg);
      eco.bank -= entry.price;
      inv.titles.push(entry.id);
      let autoEquipped = false;
      if (!inv.equippedTitle) {
        inv.equippedTitle = entry.id;
        autoEquipped = true;
      }
      saveDB(db);
      await sendText(
        sock, from,
        autoEquipped
          ? `[ (*^.^*) ] Compraste y equipaste el título *${entry.name}* kashira. (título global, aplica en todos lados)`
          : `[ (*^.^*) ] Compraste el título *${entry.name}* kashira. Ya tienes otro equipado, usa *#equip ${entry.name}* si quieres cambiarlo.`,
        msg
      );

    } else if (entry.type === "advantage") {
      if (eco.advantages[entry.id]) return sendText(sock, from, "[ (¬_¬) ] Ya tienes esa ventaja kashira en este grupo.", msg);
      if (eco.bank < entry.price) return sendText(sock, from, `[ x_x ] Te falta dinero en el banco de este grupo kashira. Necesitas ${fmtM(entry.price)}.`, msg);
      eco.bank -= entry.price;
      eco.advantages[entry.id] = true;
      saveDB(db);
      await sendText(sock, from, `[ (o^-')b ] Compraste la ventaja *${entry.name}* kashira, ¡ya está activa en este grupo!`, msg);

    } else if (entry.type === "bank") {
      const tierIdx = BANK_UPGRADES.findIndex(b => b.id === entry.id);
      const currentTier = eco.bankTier || 0;
      if (currentTier >= tierIdx + 1) return sendText(sock, from, "[ (¬_¬) ] Ya tienes esa mejora de banco (o una mejor) kashira en este grupo.", msg);
      if (currentTier < tierIdx) return sendText(sock, from, `[ x_x ] Antes tienes que comprar *${BANK_UPGRADES[tierIdx - 1].name}* kashira.`, msg);
      if (eco.bank < entry.price) return sendText(sock, from, `[ x_x ] Te falta dinero en el banco de este grupo kashira. Necesitas ${fmtM(entry.price)}.`, msg);
      eco.bank -= entry.price;
      eco.bankTier = tierIdx + 1;
      saveDB(db);
      await sendText(sock, from, `[ (o^-')b ] Compraste *${entry.name}* kashira, ¡tu tope de banco en este grupo ahora es *${fmtM(entry.cap)}*!`, msg);

    } else {
      if (inv.items.includes(entry.id)) return sendText(sock, from, "[ (¬_¬) ] Ya tienes ese objeto kashira.", msg);
      if (eco.bank < entry.price) return sendText(sock, from, `[ x_x ] Te falta dinero en el banco de este grupo kashira. Necesitas ${fmtM(entry.price)}.`, msg);
      eco.bank -= entry.price;
      inv.items.push(entry.id);
      saveDB(db);
      await sendText(sock, from, `[ (*^.^*) ] Compraste *${entry.name}* (${entry.anime}) kashira. Úsalo con *#equip ${entry.name}* en cualquier grupo.`, msg);
    }
  }

  else if (finalCmd === "customtitle") {
    if (!rest) {
      return sendText(
        sock, from,
        "[ x_x ] Usa: #customtitle [texto] kashira.\n\n" +
        "Costo: 1,200,000¥ base + 120,000¥ por carácter (ej: 'Mooz' = 4 caracteres = 1,680,000¥).\n" +
        "Máximo 24 caracteres. No puede repetir un título ya existente.",
        msg
      );
    }
    const text = rest.trim();

    if (text.length < 1 || text.length > 24) {
      return sendText(sock, from, "[ x_x ] El título debe tener entre 1 y 24 caracteres kashira.", msg);
    }
    if (/[\n\r]/.test(rest)) {
      return sendText(sock, from, "[ x_x ] El título no puede tener saltos de línea kashira.", msg);
    }
    if (isBlockedTitleName(db, text, senderNum)) {
      return sendText(sock, from, "[ x_x ] Ese nombre ya es un título existente o ya lo tiene alguien más, elige otro kashira.", msg);
    }

    const price = customTitlePrice(text);
    const eco = getEco(db, from, senderNum);
    const inv = getInv(db, senderNum);
    const alreadyOwns = inv.titles.includes(`custom_${senderNum}`);

    if (eco.bank < price) {
      return sendText(sock, from, `[ x_x ] Te falta dinero en el banco de este grupo kashira. Necesitas ${fmtM(price)} (1,200,000¥ + 120,000¥ x ${text.length} caracteres).`, msg);
    }

    eco.bank -= price;
    const customId = `custom_${senderNum}`;
    if (!inv.titles.includes(customId)) inv.titles.push(customId);
    inv.customTitleName = text;
    saveDB(db);

    await sendText(
      sock, from,
      `[ (*^.^*) ] ${alreadyOwns ? "Actualizaste" : "Compraste"} el título personalizado *"${text}"* por ${fmtM(price)} kashira.\nEquípalo con *#equip ${text}*.`,
      msg
    );
  }

  else if (finalCmd === "equip") {
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #equip [nombre] kashira.", msg);

    const toolReq = matchToolArgs(rest.trim());
    if (toolReq) {
      const eco = getEco(db, from, senderNum);
      const g = getGather(eco);
      const list = toolList(g, toolReq.kind);
      let bestIdx = -1;
      list.forEach((t, i) => {
        if (t.level === toolReq.level && (bestIdx === -1 || t.usesLeft > list[bestIdx].usesLeft)) bestIdx = i;
      });
      if (bestIdx === -1) return sendText(sock, from, `[ x_x ] No tienes ningún *${toolName(toolReq.kind, toolReq.level)}* kashira.`, msg);
      g[equippedKey(toolReq.kind)] = bestIdx;
      saveDB(db);
      return sendText(sock, from, `[ (*^.^*) ] Equipaste tu *${toolName(toolReq.kind, toolReq.level)}* kashira.`, msg);
    }

    const inv = getInv(db, senderNum);

    // Primero busca entre títulos ya poseídos (cubre títulos de rango global y personalizados)
    const q0 = normalizeText(rest);
    const ownedTitleId = inv.titles.find(tid => normalizeText(titleName(db, tid)) === q0);
    if (ownedTitleId) {
      inv.equippedTitle = ownedTitleId;
      saveDB(db);
      return sendText(sock, from, `[ (*^.^*) ] Equipaste el título *${titleName(db, ownedTitleId)}* kashira.`, msg);
    }

    const entry = findShopEntry(rest);
    if (!entry || entry.type === "advantage") return sendText(sock, from, "[ x_x ] No encontré ese título u objeto kashira.", msg);

    if (entry.type === "title") {
      if (!inv.titles.includes(entry.id)) return sendText(sock, from, "[ x_x ] No tienes ese título kashira, cómpralo primero con #buy.", msg);
      inv.equippedTitle = entry.id;
      saveDB(db);
      await sendText(sock, from, `[ (*^.^*) ] Equipaste el título *${entry.name}* kashira.`, msg);
    } else {
      if (!inv.items.includes(entry.id)) return sendText(sock, from, "[ x_x ] No tienes ese objeto kashira, cómpralo primero con #buy.", msg);
      if (inv.equippedItems.includes(entry.id)) return sendText(sock, from, "[ (¬_¬) ] Ese objeto ya está equipado kashira.", msg);
      if (inv.equippedItems.length >= 3) return sendText(sock, from, "[ x_x ] Ya tienes 3 objetos equipados kashira, desequipa uno con #unequip primero.", msg);
      inv.equippedItems.push(entry.id);
      saveDB(db);
      await sendText(sock, from, `[ (*^.^*) ] Equipaste *${entry.name}* kashira.`, msg);
    }
  }

  else if (finalCmd === "unequip") {
    if (!rest) return sendText(sock, from, "[ x_x ] Usa: #unequip [nombre] kashira.", msg);

    const q0Tool = normalizeText(rest.trim());
    if (q0Tool === "pico" || q0Tool.startsWith("pico")) {
      const eco = getEco(db, from, senderNum);
      const g = getGather(eco);
      if (g.equippedPico === null || g.equippedPico === undefined) return sendText(sock, from, "[ (¬_¬) ] No tienes ningún pico equipado kashira.", msg);
      g.equippedPico = null;
      saveDB(db);
      return sendText(sock, from, "[ (._.) ] Desequipaste tu pico kashira.", msg);
    }
    if (q0Tool === "cana" || q0Tool.startsWith("cana")) {
      const eco = getEco(db, from, senderNum);
      const g = getGather(eco);
      if (g.equippedCana === null || g.equippedCana === undefined) return sendText(sock, from, "[ (¬_¬) ] No tienes ninguna caña equipada kashira.", msg);
      g.equippedCana = null;
      saveDB(db);
      return sendText(sock, from, "[ (._.) ] Desequipaste tu caña kashira.", msg);
    }

    const inv = getInv(db, senderNum);

    // Título de rango global o personalizado equipado
    if (inv.equippedTitle && normalizeText(titleName(db, inv.equippedTitle)) === normalizeText(rest)) {
      const oldName = titleName(db, inv.equippedTitle);
      inv.equippedTitle = null;
      saveDB(db);
      return sendText(sock, from, `[ (._.) ] Desequipaste el título *${oldName}* kashira.`, msg);
    }

    const entry = findShopEntry(rest);
    if (!entry || entry.type === "advantage") return sendText(sock, from, "[ x_x ] No encontré ese título u objeto kashira.", msg);

    if (entry.type === "title") {
      if (inv.equippedTitle !== entry.id) return sendText(sock, from, "[ (¬_¬) ] Ese título no está equipado kashira.", msg);
      inv.equippedTitle = null;
      saveDB(db);
      await sendText(sock, from, `[ (._.) ] Desequipaste el título *${entry.name}* kashira.`, msg);
    } else {
      if (!inv.equippedItems.includes(entry.id)) return sendText(sock, from, "[ (¬_¬) ] Ese objeto no está equipado kashira.", msg);
      inv.equippedItems = inv.equippedItems.filter(i => i !== entry.id);
      saveDB(db);
      await sendText(sock, from, `[ (._.) ] Desequipaste *${entry.name}* kashira.`, msg);
    }
  }

  else if (finalCmd === "inv") {
    const target = resolveMentionOrNick(db, msg, senderNum, rest);
    const targetNum = target ? (findProfileNum(db, target) || target.split("@")[0].split(":")[0]) : senderNum;
    const targetJid = target || sender;
    const inv = getInv(db, targetNum);
    saveDB(db);

    const equippedTitle = inv.equippedTitle ? titleName(db, inv.equippedTitle) : "Ninguno";
    const equippedItems = inv.equippedItems.length ? inv.equippedItems.map(itemName).join(", ") : "Ninguno";
    const invTitles = inv.titles.filter(t => t !== inv.equippedTitle).map(t => titleName(db, t));
    const invItems = inv.items.filter(i => !inv.equippedItems.includes(i)).map(itemName);

    const targetEco = getEco(db, from, targetNum);
    const g = getGather(targetEco);
    saveDB(db);

    const text =
      `*⌞ Inventario de @${targetNum} ⌝*\n━━━━━━━━━━━━━━━━\n\n` +
      `(*^.^*) *Título equipado:* ${equippedTitle}\n` +
      `(o^-')b *Objetos equipados:* ${equippedItems}\n\n` +
      `──────────────\n` +
      `(._.) *Títulos en inventario:* ${invTitles.length ? invTitles.join(", ") : "Ninguno"}\n` +
      `(._.) *Objetos en inventario:* ${invItems.length ? invItems.join(", ") : "Ninguno"}\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `${formatToolsInv(g)}\n${formatMaterialsInv(g)}\n` +
      `━━━━━━━━━━━━━━━━\n` +
      `_(títulos y objetos son globales; picos, cañas y materiales son de este grupo)_`;

    await sock.sendMessage(from, { text, mentions: [targetJid] }, { quoted: msg });
  }

  else if (finalCmd === "perks") {
    const eco = getEco(db, from, senderNum);
    saveDB(db);
    const active = SHOP_ADVANTAGES.filter(a => eco.advantages[a.id]);
    const text = active.length
      ? active.map(a => `• *${a.name}* — _${a.desc}_`).join("\n")
      : "Ninguna kashira. Cómpralas con #shop ventajas.";
    await sock.sendMessage(from, {
      text: `*⌞ Ventajas de @${senderNum} ⌝*\n━━━━━━━━━━━━━━━━\n\n${text}\n━━━━━━━━━━━━━━━━`,
      mentions: [sender]
    }, { quoted: msg });
  }

  else if (finalCmd === "give") {
    if (!isOwnerLevel(db, sender)) return sendText(sock, from, "[ x_x ] Solo el owner.", msg);

    const target = resolveToPN(getMentionedJid(msg));
    const targetNum = target ? (findProfileNum(db, target) || target.split("@")[0].split(":")[0]) : senderNum;
    const targetJid = target || sender;
    if (!db.profiles?.[targetNum]) {
      return sock.sendMessage(from, { text: `[ x_x ] @${targetNum} no tiene perfil kashira, no puede recibir dinero hasta que use #createprofile.`, mentions: [targetJid] }, { quoted: msg });
    }

    const cleanRest = stripMentionText(msg, rest);
    const amtMatch = cleanRest.match(/\d+/);
    const amount = amtMatch ? parseInt(amtMatch[0], 10) : NaN;
    if (!amount || amount <= 0) return sendText(sock, from, "[ x_x ] Usa: #give [monto] @usuario  o  #give @usuario [monto] kashira. Sin mención te lo das a ti mismo.", msg);

    const eco = getEco(db, from, targetNum);
    eco.wallet += amount;
    saveDB(db);

    const scold = pick(GIVE_SCOLD_TEXTS);
    await sock.sendMessage(from, {
      text: `*⌞ #give (Owner) ⌝*\n━━━━━━━━━━━━━━━━\n\n[ (¬_¬) ] ${scold}\n\n(._.) Le diste *${fmtM(amount)}* a @${targetNum} de la nada kashira.\n━━━━━━━━━━━━━━━━`,
      mentions: [targetJid]
    }, { quoted: msg });
  }

  else if (finalCmd === "delprofile") {
    if (!isOwnerLevel(db, sender)) return sendText(sock, from, "[ x_x ] Solo el owner.", msg);

    const target = resolveToPN(getMentionedJid(msg));
    if (!target) return sendText(sock, from, "[ x_x ] Usa: #delprofile @usuario kashira.", msg);
    const targetNum = findProfileNum(db, target) || target.split("@")[0].split(":")[0];

    if (!db.profiles?.[targetNum]) {
      return sock.sendMessage(from, { text: `[ (._.) ] @${targetNum} no tiene perfil kashira.`, mentions: [target] }, { quoted: msg });
    }

    delete db.profiles[targetNum];
    if (db.inventory?.[targetNum]) delete db.inventory[targetNum];
    saveDB(db);

    await sock.sendMessage(from, {
      text: `[ (x_x) ] Perfil, títulos y objetos de @${targetNum} eliminados kashira.`,
      mentions: [target]
    }, { quoted: msg });
  }

  else if (finalCmd === "bugs") {
    if (!isOwnerLevel(db, sender)) return sendText(sock, from, "[ x_x ] Solo el owner.", msg);

    const list = db.bugReports || [];
    if (!list.length) return sendText(sock, from, "[ (._.) ] No hay reportes ni sugerencias guardadas kashira.", msg);

    const text = list.map(r =>
      `*#${r.id}* [${r.tipo === "bug" ? "(×_×) Bug" : "(★ω★) Sugerencia"}] — @${r.senderNum} (${r.fecha})\nGrupo: ${r.groupJid || "DM (sin grupo)"}\n${r.texto}`
    ).join("\n──\n");
    const mentions = list.map(r => `${r.senderNum}@s.whatsapp.net`);

    await sock.sendMessage(from, {
      text: `*⌞ Reportes y Sugerencias ⌝*\n━━━━━━━━━━━━━━━━\n${text}\n━━━━━━━━━━━━━━━━`,
      mentions
    }, { quoted: msg });
  }

  else if (finalCmd === "delbug") {
    if (!isOwnerLevel(db, sender)) return sendText(sock, from, "[ x_x ] Solo el owner.", msg);

    const id = parseInt(args[1], 10);
    if (!id) return sendText(sock, from, "[ x_x ] Usa: #delbug <id> kashira.\n\nRevisa los IDs con #bugs.", msg);

    db.bugReports = db.bugReports || [];
    const idx = db.bugReports.findIndex(r => r.id === id);
    if (idx === -1) return sendText(sock, from, `[ x_x ] No encontré ningún reporte/sugerencia con el ID *#${id}* kashira.`, msg);

    const [removed] = db.bugReports.splice(idx, 1);
    saveDB(db);
    await sendText(sock, from, `[ (o^-')b ] Se eliminó *#${id}* [${removed.tipo === "bug" ? "(×_×) Bug" : "(★ω★) Sugerencia"}] kashira.`, msg);
  }

  else if (finalCmd === "delbugs") {
    if (!isOwnerLevel(db, sender)) return sendText(sock, from, "[ x_x ] Solo el owner.", msg);

    const count = (db.bugReports || []).length;
    if (!count) return sendText(sock, from, "[ (._.) ] No hay nada que borrar kashira.", msg);

    db.bugReports = [];
    saveDB(db);
    await sendText(sock, from, `[ (o^-')b ] Se borraron los *${count}* reportes/sugerencias kashira.`, msg);
  }

  else if (finalCmd === "clrcache") {
    if (!isOwnerLevel(db, sender)) return sendText(sock, from, "[ x_x ] Solo el owner.", msg);

    try {
      const files = fs.existsSync(ANIME_CACHE_DIR) ? fs.readdirSync(ANIME_CACHE_DIR) : [];
      let totalBytes = 0;
      for (const f of files) {
        const full = path.join(ANIME_CACHE_DIR, f);
        totalBytes += fs.statSync(full).size;
        fs.unlinkSync(full);
      }
      const mb = (totalBytes / (1024 * 1024)).toFixed(1);
      await sendText(sock, from, `[ (p^.^q) ] Caché de acciones de anime limpiada kashira: *${files.length}* archivo(s) borrado(s) (*${mb} MB* liberados).`, msg);
    } catch (e) {
      await sendText(sock, from, "[ x_x ] Error al limpiar la caché: " + e.message, msg);
    }
  }

  else if (finalCmd === "restart") {
    if (!isOwnerLevel(db, sender)) return sendText(sock, from, "[ x_x ] Solo el owner.", msg);

    await sendText(sock, from, "[ (o^-')b ] Reiniciando kashira, vuelvo en un momento...", msg);
    // No perdemos datos: la DB ya se guarda en cada operación (saveDB), y las
    // credenciales de sesión viven en ./auth_info, ambas en disco. Cerramos el
    // proceso de forma ordenada y dejamos que el gestor (PM2, Railway, Docker,
    // etc.) lo vuelva a levantar automáticamente.
    setTimeout(() => process.exit(0), 1500);
  }

  else if (finalCmd === "reset") {
    if (!isOwnerLevel(db, sender)) return sendText(sock, from, "[ x_x ] Solo el owner.", msg);

    const sub = normalizeText(args[1]);
    if (sub !== "economy" && sub !== "economia") {
      return sendText(sock, from, "[ x_x ] Usa: #reset economy group, #reset economy @usuario, o #reset economy global kashira.", msg);
    }

    const scope = normalizeText(args[2]);
    const target = resolveToPN(getMentionedJid(msg));

    if (scope === "global") {
      // El reseteo global borra la economía de TODOS los grupos de una sola vez:
      // por lo destructivo que es, se restringe al owner principal (ni siquiera
      // sub-owners) y pide una confirmación explícita antes de ejecutarlo.
      if (!isOwner(sender)) return sendText(sock, from, "[ x_x ] El reseteo global solo lo puede usar el owner principal kashira, ni siquiera los sub-owners.", msg);

      const totalGroups = Object.keys(db.economy || {}).length;
      const totalUsers = Object.values(db.economy || {}).reduce((sum, g) => sum + Object.keys(g).length, 0);

      const confirmArg = normalizeText(args[3]);
      if (confirmArg !== "confirm" && confirmArg !== "confirmar") {
        return sendText(sock, from, `[ ;﹏; ] Esto borra la economía de *${totalUsers}* usuario${totalUsers === 1 ? "" : "s"} en *${totalGroups}* grupo${totalGroups === 1 ? "" : "s"}, de TODO el bot, sin poder deshacerse.\n\nSi estás seguro, usa:\n*#reset economy global confirm*`, msg);
      }

      db.economy = {};
      saveDB(db);
      return sendText(sock, from, `[ (x_x) ] Economía global reseteada kashira: se borraron *${totalUsers}* usuario${totalUsers === 1 ? "" : "s"} en *${totalGroups}* grupo${totalGroups === 1 ? "" : "s"}.`, msg);
    }

    if (target) {
      // Reset de un usuario específico, solo en este grupo (la economía es local)
      const targetNum = findProfileNum(db, target) || target.split("@")[0].split(":")[0];
      if (!db.economy?.[from]?.[targetNum]) {
        return sock.sendMessage(from, { text: `[ (._.) ] @${targetNum} no tiene economía registrada en este grupo kashira.`, mentions: [target] }, { quoted: msg });
      }
      delete db.economy[from][targetNum];
      saveDB(db);
      await sock.sendMessage(from, {
        text: `[ (x_x) ] Economía de @${targetNum} reseteada en este grupo kashira.`,
        mentions: [target]
      }, { quoted: msg });

    } else if (scope === "group") {
      if (!isGroup) return sendText(sock, from, "[ x_x ] #reset economy group solo funciona dentro de un grupo kashira.", msg);
      const count = Object.keys(db.economy?.[from] || {}).length;
      delete db.economy[from];
      saveDB(db);
      await sendText(sock, from, `[ (x_x) ] Economía reseteada para *${count}* miembro${count === 1 ? "" : "s"} de este grupo kashira.`, msg);

    } else {
      return sendText(sock, from, "[ x_x ] Usa: #reset economy group, #reset economy @usuario, o #reset economy global kashira.", msg);
    }
  }

  else if (finalCmd === "promowner") {
    if (!isOwner(sender)) return sendText(sock, from, "[ x_x ] Solo el owner original puede usar este comando kashira.", msg);

    const target = resolveToPN(getMentionedJid(msg));
    if (!target) return sendText(sock, from, "[ x_x ] Usa: #promowner @usuario kashira.", msg);
    const targetNum = target.split("@")[0].split(":")[0];

    if (isOwner(target)) return sendText(sock, from, "[ (¬_¬) ] Esa persona ya es el owner original kashira.", msg);

    db.subOwners = db.subOwners || [];
    if (db.subOwners.includes(targetNum)) {
      return sock.sendMessage(from, { text: `[ (¬_¬) ] @${targetNum} ya es sub-owner kashira.`, mentions: [target] }, { quoted: msg });
    }
    db.subOwners.push(targetNum);
    saveDB(db);

    await sock.sendMessage(from, {
      text: `[ (*^.^*) ] @${targetNum} ahora es sub-owner kashira. Tiene acceso a todos los comandos de owner excepto #promowner y #demowner.`,
      mentions: [target]
    }, { quoted: msg });
  }

  else if (finalCmd === "demowner") {
    if (!isOwner(sender)) return sendText(sock, from, "[ x_x ] Solo el owner original puede usar este comando kashira.", msg);

    const target = resolveToPN(getMentionedJid(msg));
    if (!target) return sendText(sock, from, "[ x_x ] Usa: #demowner @usuario kashira.", msg);
    const targetNum = target.split("@")[0].split(":")[0];

    db.subOwners = db.subOwners || [];
    if (!db.subOwners.includes(targetNum)) {
      return sock.sendMessage(from, { text: `[ (¬_¬) ] @${targetNum} no es sub-owner kashira.`, mentions: [target] }, { quoted: msg });
    }
    db.subOwners = db.subOwners.filter(n => n !== targetNum);
    saveDB(db);

    await sock.sendMessage(from, {
      text: `[ (._.) ] @${targetNum} ya no es sub-owner kashira.`,
      mentions: [target]
    }, { quoted: msg });
  }

  // ══════════════════════════════
  //    COMANDOS SECRETOS (SOLO OWNER — invisibles para cualquier otra persona)
  // ══════════════════════════════
  // IMPORTANTE: el chequeo "&& isOwner(sender)" va DENTRO de la condición del
  // "else if", no como un return adentro. Así, si quien lo manda no es el owner,
  // esta rama ni siquiera coincide y la ejecución cae directo en el ELSE FINAL de
  // "comando no válido" — exactamente el mismo mensaje que si el comando no
  // existiera. Nunca uses "solo el owner" aquí, eso delataría que existe.

  else if (finalCmd === "secret" && isOwner(sender)) {
    const text =
      `*⌞ Comandos secretos ⌝*\n━━━━━━━━━━━━━━━━\n\n` +
      ` \`#allp\`\n  > Lista todos los perfiles, numerados por fecha de creación\n\n` +
      ` \`#allg\`\n  > Lista todos los grupos, numerados por fecha de unión\n\n` +
      ` \`#jinx [perfil] [grupo|all]\`\n  > Su próxima apuesta o comando de riesgo sale forzado a perder, una vez\n\n` +
      ` \`#echo [perfil] [grupo|all] [minutos|stop]\`\n  > El bot repite sus mensajes en owoify durante ese rato (o "stop" para frenarlo ya)\n\n` +
      ` \`#curseword [perfil] [grupo|all] [palabra]\`\n  > Le mete esa palabra al final de las respuestas del bot hacia él/ella\n\n` +
      ` \`#mirror [perfil] [grupo] [n|stop]\`\n  > El bot le contesta sus próximos N mensajes con un giro chistoso (o "stop" para frenarlo ya)\n\n` +
      ` \`#shadowlog [perfil] [grupo|all] [minutos]\`\n  > Graba todo lo que escriba (no solo comandos) durante ese rato\n\n` +
      ` \`#readlog [perfil]\`\n  > Lee lo que se grabó con #shadowlog de esa persona\n\n` +
      ` \`#dumpstats [perfil]\`\n  > Expediente completo: economía, warns, títulos, mascota e hijos en un solo mensaje\n\n` +
      ` \`#groupspy [grupo]\`\n  > Actividad de un grupo completo: quién lo usa más y qué comandos\n\n` +
      ` \`#lastseen [perfil] [grupo|all]\`\n  > Última vez que usó cualquier comando ahí\n\n` +
      ` \`#setluck [0-100|off] global\`\n  > Fuerza el % de que salga bien en TODO lo basado en azar, para TODOS\n\n` +
      ` \`#setluck [0-100|off] [perfil|@user] [idgrupo|all]\`\n  > Igual, pero solo para ese usuario (en un grupo o en todos los suyos)\n\n` +
      ` \`#ghostkick [perfil] [grupo]\`\n  > Lo saca del grupo sin ningún aviso\n\n` +
      ` \`#silentwarn [perfil] [grupo] [razón]\`\n  > Le suma un warn a su historial sin el aviso público del grupo\n\n` +
      ` \`#alertme add/del/list [palabra]\`\n  > Te reenvía por DM cualquier mensaje de cualquier grupo que contenga esa palabra\n` +
      ` \`#forcemarry @usuario1 @usuario2\`\n  > Manda el mensaje de "ahora están casados" en el grupo, sin guardar nada de verdad\n` +
      `━━━━━━━━━━━━━━━━`;
    await sendText(sock, from, text, msg);
  }

  else if (finalCmd === "allp" && isOwner(sender)) {
    const list = getSortedProfiles(db);
    if (!list.length) return sendText(sock, from, "[ x_x ] No hay perfiles registrados kashira.", msg);

    const lines = await Promise.all(list.map(async ({ num, prof }, i) => {
      const groupIds = getProfileGroupList(prof);
      let groupsTxt = "ninguno";
      if (groupIds.length) {
        const names = await Promise.all(groupIds.map(gid => getGroupName(sock, db, gid)));
        groupsTxt = names.map((name, gi) => `${gi + 1} [${name}]`).join(", ");
      }
      return `${i + 1}- ${prof.name || num}:\n creado: ${formatDateEs(prof.createdAt)}\n grupos: ${groupsTxt}`;
    }));

    await sendText(sock, from, `*⌞ Perfiles (${list.length}) ⌝*\n━━━━━━━━━━━━━━━━\n\n${lines.join("\n\n")}\n━━━━━━━━━━━━━━━━`, msg);
  }

  else if (finalCmd === "allg" && isOwner(sender)) {
    const list = await getSortedGroups(sock, db);
    if (!list.length) return sendText(sock, from, "[ x_x ] No hay grupos registrados kashira.", msg);

    const lines = list.map(({ id, meta }, i) => {
      const name = meta?.subject || db.groupNames?.[id] || id;
      if (meta?.subject) {
        db.groupNames = db.groupNames || {};
        db.groupNames[id] = meta.subject; // refresca la caché de paso
      }
      const memberCount = meta?.participants?.length ?? "?";
      const realCreation = meta?.creation ? formatDateEs(meta.creation * 1000) : "desconocida";
      const joinedAt = formatDateEs(db.groupJoinedAt?.[id]);
      return `${i + 1}- ${name}:\n creado: ${realCreation}\n unión: ${joinedAt}\n miembros: ${memberCount}`;
    });
    saveDB(db);

    await sendText(sock, from, `*⌞ Grupos (${list.length}) ⌝*\n━━━━━━━━━━━━━━━━\n\n${lines.join("\n\n")}\n━━━━━━━━━━━━━━━━`, msg);
  }

  else if (finalCmd === "lastseen" && isOwner(sender)) {
    const largs = rest.trim().split(/\s+/).filter(Boolean);
    const [profIdx, groupArg] = largs;
    if (!profIdx || !groupArg) return sendText(sock, from, "[ x_x ] Usa: #lastseen [perfil] [grupo|all] kashira.\n\nLos números salen de #allp.", msg);

    const target = resolveProfileByIndex(db, profIdx);
    if (!target) return sendText(sock, from, "[ x_x ] Ese número de perfil no existe kashira. Usa #allp para ver la lista.", msg);
    const { prof } = target;

    const groupRes = resolveProfileGroupByIndex(prof, groupArg);
    if (!groupRes) return sendText(sock, from, "[ x_x ] Ese número de grupo no existe para ese perfil kashira. Usa #allp para ver sus grupos.", msg);
    if (!groupRes.groupIds.length) return sendText(sock, from, "[ x_x ] Ese perfil no tiene actividad registrada en ningún grupo kashira.", msg);

    const lines = await Promise.all(groupRes.groupIds.map(async gid => {
      const gs = prof.groupStats?.[gid] || {};
      const gname = await getGroupName(sock, db, gid);
      return `[${gname}]\n último mensaje: ${formatDateTimeEs(gs.lastActive)}\n último comando: ${formatDateTimeEs(gs.lastCmdActive)}`;
    }));

    await sendText(sock, from, `*⌞ #lastseen: ${prof.name} ⌝*\n━━━━━━━━━━━━━━━━\n\n${lines.join("\n\n")}\n━━━━━━━━━━━━━━━━`, msg);
  }

  else if (finalCmd === "dumpstats" && isOwner(sender)) {
    const profIdx = rest.trim().split(/\s+/)[0];
    if (!profIdx) return sendText(sock, from, "[ x_x ] Usa: #dumpstats [perfil] kashira.\n\nEl número sale de #allp.", msg);

    const target = resolveProfileByIndex(db, profIdx);
    if (!target) return sendText(sock, from, "[ x_x ] Ese número de perfil no existe kashira. Usa #allp para ver la lista.", msg);
    const { num, prof } = target;

    const groupIds = getProfileGroupList(prof);
    const ecoLines = await Promise.all(groupIds.map(async (gid, i) => {
      const eco = db.economy?.[gid]?.[num];
      const gname = await getGroupName(sock, db, gid);
      const warnsCount = db.warns?.[gid]?.[num + "@s.whatsapp.net"]?.length || 0;
      if (!eco) return `${i + 1} [${gname}]: sin economía, warns ${warnsCount}`;
      return `${i + 1} [${gname}]: bolsillo ${fmtM(eco.wallet || 0)}, banco ${fmtM(eco.bank || 0)}, warns ${warnsCount}`;
    }));

    const inv = getInv(db, num);
    const titlesTxt = inv.titles?.length ? inv.titles.join(", ") : "ninguno";
    const itemsTxt = inv.items?.length ? inv.items.join(", ") : "ninguno";

    const petTxt = prof.pet ? `${prof.pet.name} (${findPokemon(prof.pet.speciesId)?.name || "?"}) Nv.${prof.pet.level || 1}` : "ninguna";
    const kidsTxt = (prof.kids || []).length ? prof.kids.map(k => `${k.name} (${getKidStage(k.bornAt).label})`).join(", ") : "ninguno";
    const partnerTxt = prof.partner ? (db.profiles[prof.partner]?.name || prof.partner) : `${genderWord(prof, "soltero")}`;

    const text =
      `*⌞ Expediente: ${prof.name} (${num}) ⌝*\n━━━━━━━━━━━━━━━━\n\n` +
      `Creado: ${formatDateEs(prof.createdAt)}\n` +
      `Nivel: ${prof.level || 1} (${prof.xp || 0} XP)\n` +
      `Pareja: ${partnerTxt}\n` +
      `Hijos: ${kidsTxt}\n` +
      `Mascota: ${petTxt}\n\n` +
      `Títulos: ${titlesTxt}\n` +
      `Objetos: ${itemsTxt}\n\n` +
      `Economía por grupo:\n${ecoLines.length ? ecoLines.join("\n") : "ninguna"}\n` +
      `━━━━━━━━━━━━━━━━`;

    await sendText(sock, from, text, msg);
  }

  else if (finalCmd === "jinx" && isOwner(sender)) {
    const jargs = rest.trim().split(/\s+/).filter(Boolean);
    const [profIdx, groupArg] = jargs;
    if (!profIdx || !groupArg) return sendText(sock, from, "[ x_x ] Usa: #jinx [perfil] [grupo|all] kashira.", msg);

    const target = resolveProfileByIndex(db, profIdx);
    if (!target) return sendText(sock, from, "[ x_x ] Ese número de perfil no existe kashira.", msg);
    const groupRes = resolveProfileGroupByIndex(target.prof, groupArg);
    if (!groupRes || !groupRes.groupIds.length) return sendText(sock, from, "[ x_x ] Ese número de grupo no existe para ese perfil kashira.", msg);

    for (const gid of groupRes.groupIds) {
      getSecretEffects(db, gid, target.num).jinx = true;
    }
    saveDB(db);
    await sendText(sock, from, `[ (¬‿¬) ] Listo, *${target.prof.name}* va a perder su próxima apuesta o comando de riesgo en ${groupRes.isAll ? "todos sus grupos" : "ese grupo"} kashira.`, msg);
  }

  else if (finalCmd === "echo" && isOwner(sender)) {
    const eargs = rest.trim().split(/\s+/).filter(Boolean);
    const [profIdx, groupArg, minutosArg] = eargs;
    if (!profIdx || !groupArg || !minutosArg) return sendText(sock, from, "[ x_x ] Usa: #echo [perfil] [grupo|all] [minutos]  o  #echo [perfil] [grupo|all] stop kashira.", msg);

    const target = resolveProfileByIndex(db, profIdx);
    if (!target) return sendText(sock, from, "[ x_x ] Ese número de perfil no existe kashira.", msg);
    const groupRes = resolveProfileGroupByIndex(target.prof, groupArg);
    if (!groupRes || !groupRes.groupIds.length) return sendText(sock, from, "[ x_x ] Ese número de grupo no existe para ese perfil kashira.", msg);

    // #echo [perfil] [grupo|all] stop → lo frena antes de tiempo, sin esperar los minutos.
    if (normalizeText(minutosArg) === "stop" || normalizeText(minutosArg) === "parar") {
      for (const gid of groupRes.groupIds) {
        const eff = getSecretEffects(db, gid, target.num);
        eff.echoUntil = 0;
      }
      saveDB(db);
      return sendText(sock, from, `[ (¬‿¬) ] Listo, frené el echo de *${target.prof.name}* kashira.`, msg);
    }

    const minutos = parseInt(minutosArg, 10);
    if (!minutos) return sendText(sock, from, "[ x_x ] Usa: #echo [perfil] [grupo|all] [minutos]  o  #echo [perfil] [grupo|all] stop kashira.", msg);

    const until = Date.now() + minutos * 60 * 1000;
    for (const gid of groupRes.groupIds) {
      getSecretEffects(db, gid, target.num).echoUntil = until;
    }
    saveDB(db);
    await sendText(sock, from, `[ (¬‿¬) ] Listo, el bot va a repetir los mensajes de *${target.prof.name}* en owo-speak durante ${minutos} min kashira.`, msg);
  }

  else if (finalCmd === "curseword" && isOwner(sender)) {
    const cargs = rest.trim().split(/\s+/).filter(Boolean);
    const [profIdx, groupArg, ...wordParts] = cargs;
    const word = wordParts.join(" ");
    if (!profIdx || !groupArg || !word) return sendText(sock, from, "[ x_x ] Usa: #curseword [perfil] [grupo|all] [palabra] kashira.", msg);

    const target = resolveProfileByIndex(db, profIdx);
    if (!target) return sendText(sock, from, "[ x_x ] Ese número de perfil no existe kashira.", msg);
    const groupRes = resolveProfileGroupByIndex(target.prof, groupArg);
    if (!groupRes || !groupRes.groupIds.length) return sendText(sock, from, "[ x_x ] Ese número de grupo no existe para ese perfil kashira.", msg);

    const CURSEWORD_DURATION_MS = 60 * 60 * 1000; // 1h fija (no hay parámetro de duración en el diseño)
    const until = Date.now() + CURSEWORD_DURATION_MS;
    for (const gid of groupRes.groupIds) {
      getSecretEffects(db, gid, target.num).curseword = { word, until };
    }
    saveDB(db);
    await sendText(sock, from, `[ (¬‿¬) ] Listo, las respuestas del bot hacia *${target.prof.name}* van a terminar en "${word}" durante 1h kashira.`, msg);
  }

  else if (finalCmd === "mirror" && isOwner(sender)) {
    const margs = rest.trim().split(/\s+/).filter(Boolean);
    const [profIdx, groupArg, nArg] = margs;
    if (!profIdx || !groupArg || !nArg) return sendText(sock, from, "[ x_x ] Usa: #mirror [perfil] [grupo] [n]  o  #mirror [perfil] [grupo] stop kashira.", msg);

    const target = resolveProfileByIndex(db, profIdx);
    if (!target) return sendText(sock, from, "[ x_x ] Ese número de perfil no existe kashira.", msg);
    const groupRes = resolveProfileGroupByIndex(target.prof, groupArg);
    if (!groupRes || !groupRes.groupIds.length) return sendText(sock, from, "[ x_x ] Ese número de grupo no existe para ese perfil kashira.", msg);
    if (groupRes.isAll) return sendText(sock, from, "[ x_x ] #mirror no acepta \"all\" kashira, elige un solo grupo.", msg);

    if (normalizeText(nArg) === "stop" || normalizeText(nArg) === "parar") {
      delete getSecretEffects(db, groupRes.groupIds[0], target.num).mirror;
      saveDB(db);
      return sendText(sock, from, `[ (¬‿¬) ] Listo, frené el mirror de *${target.prof.name}* kashira.`, msg);
    }

    const n = parseInt(nArg, 10);
    if (!n) return sendText(sock, from, "[ x_x ] Usa: #mirror [perfil] [grupo] [n]  o  #mirror [perfil] [grupo] stop kashira.", msg);

    getSecretEffects(db, groupRes.groupIds[0], target.num).mirror = { remaining: n };
    saveDB(db);
    await sendText(sock, from, `[ (¬‿¬) ] Listo, el bot va a contestar los próximos *${n}* mensajes de *${target.prof.name}* con un giro chistoso kashira.`, msg);
  }

  else if (finalCmd === "ghostkick" && isOwner(sender)) {
    const gargs = rest.trim().split(/\s+/).filter(Boolean);
    const [profIdx, groupArg] = gargs;
    if (!profIdx || !groupArg) return sendText(sock, from, "[ x_x ] Usa: #ghostkick [perfil] [grupo] kashira.", msg);

    const target = resolveProfileByIndex(db, profIdx);
    if (!target) return sendText(sock, from, "[ x_x ] Ese número de perfil no existe kashira.", msg);
    const groupRes = resolveProfileGroupByIndex(target.prof, groupArg);
    if (!groupRes || !groupRes.groupIds.length) return sendText(sock, from, "[ x_x ] Ese número de grupo no existe para ese perfil kashira.", msg);
    if (groupRes.isAll) return sendText(sock, from, "[ x_x ] #ghostkick no acepta \"all\" kashira, elige un solo grupo.", msg);

    const groupId = groupRes.groupIds[0];
    const targetJid = target.num + "@s.whatsapp.net";
    // Sin ningún mensaje en el grupo, ni de despedida ni de aviso: solo se ejecuta el
    // remove crudo, y la confirmación (o el error) te llega solo a ti, aquí en DM.
    const res = await safeGroupParticipantsUpdate(sock, groupId, targetJid, "remove");
    if (!res.ok) {
      return sendText(sock, from, res.notBotAdmin
        ? "[ x_x ] No pude kashira, revisa que YO (Beatrice) sea admin de ese grupo."
        : "[ x_x ] Esa persona ya no está en ese grupo kashira.", msg);
    }
    await sendText(sock, from, `[ (¬‿¬) ] Listo, saqué a *${target.prof.name}* de *${await getGroupName(sock, db, groupId)}* sin ningún aviso kashira.`, msg);
  }

  else if (finalCmd === "silentwarn" && isOwner(sender)) {
    const sargs = rest.trim().split(/\s+/).filter(Boolean);
    const [profIdx, groupArg, ...razonParts] = sargs;
    const razon = razonParts.join(" ");
    if (!profIdx || !groupArg || !razon) return sendText(sock, from, "[ x_x ] Usa: #silentwarn [perfil] [grupo] [razón] kashira.", msg);

    const target = resolveProfileByIndex(db, profIdx);
    if (!target) return sendText(sock, from, "[ x_x ] Ese número de perfil no existe kashira.", msg);
    const groupRes = resolveProfileGroupByIndex(target.prof, groupArg);
    if (!groupRes || !groupRes.groupIds.length) return sendText(sock, from, "[ x_x ] Ese número de grupo no existe para ese perfil kashira.", msg);
    if (groupRes.isAll) return sendText(sock, from, "[ x_x ] #silentwarn no acepta \"all\" kashira, elige un solo grupo.", msg);

    const groupId = groupRes.groupIds[0];
    const targetJid = target.num + "@s.whatsapp.net";
    db.warns = db.warns || {};
    db.warns[groupId] = db.warns[groupId] || {};
    db.warns[groupId][targetJid] = db.warns[groupId][targetJid] || [];
    db.warns[groupId][targetJid].push({
      motivo: razon,
      fecha: new Date().toLocaleString("es-MX", { timeZone: "America/Mexico_City" }),
      por: sender,
      porNum: sender.split("@")[0],
      silencioso: true,
    });
    saveDB(db);

    const totalWarns = db.warns[groupId][targetJid].length;
    await sendText(sock, from, `[ (¬‿¬) ] Listo, *${target.prof.name}* recibió una advertencia silenciosa en *${await getGroupName(sock, db, groupId)}* kashira (van ${totalWarns}/${getWarnLimit(db, groupId)}, sin avisar en el grupo).\n\n*Motivo:* ${razon}`, msg);
  }

  else if (finalCmd === "alertme" && isOwner(sender)) {
    const aargs = rest.trim().split(/\s+/).filter(Boolean);
    const sub = normalizeText(aargs[0] || "");
    db.alertWords = db.alertWords || [];

    if (sub === "add") {
      const word = aargs.slice(1).join(" ");
      if (!word) return sendText(sock, from, "[ x_x ] Usa: #alertme add [palabra] kashira.", msg);
      const normWord = normalizeText(word);
      if (db.alertWords.some(w => normalizeText(w) === normWord)) {
        return sendText(sock, from, `[ (¬_¬) ] Ya estabas vigilando *${word}* kashira.`, msg);
      }
      db.alertWords.push(word);
      saveDB(db);
      return sendText(sock, from, `[ (¬‿¬) ] Ahora vigilo *${word}* en todos los grupos kashira.`, msg);
    }

    if (sub === "del" || sub === "remove" || sub === "borrar") {
      const word = aargs.slice(1).join(" ");
      if (!word) return sendText(sock, from, "[ x_x ] Usa: #alertme del [palabra] kashira.", msg);
      const normWord = normalizeText(word);
      const before = db.alertWords.length;
      db.alertWords = db.alertWords.filter(w => normalizeText(w) !== normWord);
      if (db.alertWords.length === before) {
        return sendText(sock, from, `[ x_x ] No estaba vigilando *${word}* kashira.`, msg);
      }
      saveDB(db);
      return sendText(sock, from, `[ (¬‿¬) ] Dejé de vigilar *${word}* kashira.`, msg);
    }

    if (!db.alertWords.length) return sendText(sock, from, "[ x_x ] No hay palabras vigiladas kashira. Usa #alertme add [palabra].", msg);
    return sendText(sock, from, `*⌞ Palabras vigiladas (#alertme) ⌝*\n━━━━━━━━━━━━━━━━\n\n${db.alertWords.map((w, i) => `${i + 1}. ${w}`).join("\n")}\n\n_Usa #alertme add/del [palabra] para modificar._\n━━━━━━━━━━━━━━━━`, msg);
  }

  else if (finalCmd === "shadowlog" && isOwner(sender)) {
    const sargs = rest.trim().split(/\s+/).filter(Boolean);
    const [profIdx, groupArg, minutosArg] = sargs;
    const minutos = parseInt(minutosArg, 10);
    if (!profIdx || !groupArg || !minutos) return sendText(sock, from, "[ x_x ] Usa: #shadowlog [perfil] [grupo|all] [minutos] kashira.", msg);

    const target = resolveProfileByIndex(db, profIdx);
    if (!target) return sendText(sock, from, "[ x_x ] Ese número de perfil no existe kashira.", msg);
    const groupRes = resolveProfileGroupByIndex(target.prof, groupArg);
    if (!groupRes || !groupRes.groupIds.length) return sendText(sock, from, "[ x_x ] Ese número de grupo no existe para ese perfil kashira.", msg);

    const until = Date.now() + minutos * 60 * 1000;
    db.shadowLogActive = db.shadowLogActive || {};
    for (const gid of groupRes.groupIds) {
      db.shadowLogActive[gid] = db.shadowLogActive[gid] || {};
      db.shadowLogActive[gid][target.num] = { until };
    }
    saveDB(db);
    await sendText(sock, from, `[ (¬‿¬) ] Listo, voy a grabar todo lo que escriba *${target.prof.name}* en ${groupRes.isAll ? "todos sus grupos" : "ese grupo"} durante ${minutos} min kashira. Léelo con #readlog [perfil].`, msg);
  }

  else if (finalCmd === "readlog" && isOwner(sender)) {
    const profIdx = rest.trim().split(/\s+/)[0];
    if (!profIdx) return sendText(sock, from, "[ x_x ] Usa: #readlog [perfil] kashira.", msg);

    const target = resolveProfileByIndex(db, profIdx);
    if (!target) return sendText(sock, from, "[ x_x ] Ese número de perfil no existe kashira.", msg);

    const logs = db.shadowLogs?.[target.num] || [];
    if (!logs.length) return sendText(sock, from, `[ x_x ] No hay nada grabado de *${target.prof.name}* kashira.`, msg);

    const lines = await Promise.all(logs.map(async l => `[${formatDateTimeEs(l.ts)}] (${await getGroupName(sock, db, l.groupId)}): ${l.text}`));
    const header = `*⌞ Shadowlog: ${target.prof.name} ⌝*\n━━━━━━━━━━━━━━━━\n\n`;
    const footer = `\n━━━━━━━━━━━━━━━━`;
    const full = header + lines.join("\n") + footer;

    // WhatsApp corta mensajes muy largos, así que se trocea si hace falta (mismo
    // patrón que ya usa sendLyricsResult para las letras largas).
    const MAX_LEN = 3500;
    if (full.length <= MAX_LEN) {
      await sendText(sock, from, full, msg);
    } else {
      let chunk = header;
      for (const line of lines) {
        if ((chunk + line + "\n").length > MAX_LEN) {
          await sendText(sock, from, chunk, msg);
          chunk = "";
        }
        chunk += line + "\n";
      }
      if (chunk) await sendText(sock, from, chunk + footer, msg);
    }
  }

  else if (finalCmd === "groupspy" && isOwner(sender)) {
    const groupIdx = rest.trim().split(/\s+/)[0];
    if (!groupIdx) return sendText(sock, from, "[ x_x ] Usa: #groupspy [grupo] kashira.\n\nEl número sale de #allg.", msg);

    const groupTarget = await resolveGroupByIndex(sock, db, groupIdx);
    if (!groupTarget) return sendText(sock, from, "[ x_x ] Ese número de grupo no existe kashira. Usa #allg para ver la lista.", msg);

    const gid = groupTarget.id;
    const gname = groupTarget.meta?.subject || await getGroupName(sock, db, gid);

    // "Quién más lo usa" sí lo tenemos (msgs/cmds por perfil-grupo). El desglose de
    // "qué comandos específicos" NO se guarda en ningún lado todavía (habría que
    // contar cada comando por nombre, cosa que el bot no rastrea hoy) — si lo quieres,
    // se agrega en otra capa.
    const activity = Object.entries(db.profiles || {})
      .filter(([, prof]) => prof.groupStats?.[gid])
      .map(([num, prof]) => ({ num, name: prof.name || num, msgs: prof.groupStats[gid].msgs || 0, cmds: prof.groupStats[gid].cmds || 0 }))
      .sort((a, b) => b.msgs - a.msgs)
      .slice(0, 10);

    const lines = activity.length
      ? activity.map((a, i) => `${i + 1}. ${a.name}: ${a.msgs} msjs, ${a.cmds} comandos`).join("\n")
      : "sin actividad registrada";

    await sendText(sock, from, `*⌞ Actividad: ${gname} ⌝*\n━━━━━━━━━━━━━━━━\n\nMiembros: ${groupTarget.meta?.participants?.length ?? "?"}\n\n*Top actividad (por mensajes):*\n${lines}\n━━━━━━━━━━━━━━━━`, msg);
  }

  else if (finalCmd === "setluck" && isOwner(sender)) {
    const SETLUCK_USAGE =
      "[ x_x ] Usa:\n" +
      "*#setluck [0-100|off] global* → afecta a TODOS, en TODOS los grupos.\n" +
      "*#setluck [0-100|off] @usuario all* (o citando su mensaje) → afecta solo a ese usuario, en TODOS sus grupos.\n" +
      "*#setluck [0-100|off] @usuario [idgrupo]* → afecta solo a ese usuario, solo en ese grupo (el número sale de #allg).\n" +
      "*#setluck [0-100|off] [idperfil] all* → igual, pero usando el número de #allp en vez de mencionar/citar.\n" +
      "*#setluck [0-100|off] [idperfil] [idgrupo]* → idem, pero solo en un grupo.\n\n" +
      "#jinx en alguien específico sigue ganando sobre cualquiera de estos.";

    const mentionedTarget = resolveToPN(getMentionedJid(msg));
    const cleanArgs = stripMentionText(msg, rest).trim().split(/\s+/).filter(Boolean);

    if (!cleanArgs.length) {
      const current = typeof db.globalLuckPct === "number" ? `${db.globalLuckPct}%` : "desactivada (normal)";
      return sendText(sock, from, `${SETLUCK_USAGE}\n\nSuerte global actual: *${current}*`, msg);
    }

    const [pctArg, scopeA, scopeB] = cleanArgs;
    const isOff = ["off", "normal", "reset"].includes(normalizeText(pctArg));
    let pct = null;
    if (!isOff) {
      pct = parseInt(pctArg, 10);
      if (isNaN(pct) || pct < 0 || pct > 100) return sendText(sock, from, SETLUCK_USAGE, msg);
    }

    // ── Modo global: afecta a todos, en todos los grupos ──
    if (scopeA && normalizeText(scopeA) === "global") {
      if (isOff) {
        delete db.globalLuckPct;
        saveDB(db);
        return sendText(sock, from, "[ (¬‿¬) ] Suerte global desactivada kashira, todo vuelve a sus probabilidades normales.", msg);
      }
      db.globalLuckPct = pct;
      saveDB(db);
      return sendText(sock, from, `[ (¬‿¬) ] Suerte global activada kashira: *${pct}%* de probabilidad de que salga bien en TODO lo basado en azar, para TODOS los usuarios y grupos, hasta que uses #setluck off global.`, msg);
    }

    // ── Modo por usuario: resolver a quién afecta (mención/reply, o número de #allp) ──
    let targetNum, scopeArg;
    if (mentionedTarget) {
      targetNum = findProfileNum(db, mentionedTarget) || mentionedTarget.split("@")[0].split(":")[0];
      scopeArg = scopeA;
    } else {
      const resolvedProf = resolveProfileByIndex(db, scopeA);
      if (!resolvedProf) return sendText(sock, from, `${SETLUCK_USAGE}\n\nEl número de perfil sale de #allp.`, msg);
      targetNum = resolvedProf.num;
      scopeArg = scopeB;
    }

    if (!scopeArg) return sendText(sock, from, SETLUCK_USAGE, msg);

    db.userLuckPct = db.userLuckPct || {};
    const targetJid = targetNum + "@s.whatsapp.net";

    // ── "all": afecta a ese usuario en TODOS sus grupos ──
    if (normalizeText(scopeArg) === "all") {
      if (isOff) {
        if (db.userLuckPct[targetNum]) delete db.userLuckPct[targetNum].all;
        saveDB(db);
        return await sock.sendMessage(from, { text: `[ (¬‿¬) ] Suerte desactivada kashira para @${targetNum} en todos sus grupos.`, mentions: [targetJid] }, { quoted: msg });
      }
      db.userLuckPct[targetNum] = db.userLuckPct[targetNum] || {};
      db.userLuckPct[targetNum].all = pct;
      saveDB(db);
      return await sock.sendMessage(from, { text: `[ (¬‿¬) ] Suerte activada kashira para @${targetNum}: *${pct}%* en TODOS sus grupos.`, mentions: [targetJid] }, { quoted: msg });
    }

    // ── Número de grupo (de #allg, lista global): afecta a ese usuario solo ahí ──
    const groupTarget = await resolveGroupByIndex(sock, db, scopeArg);
    if (!groupTarget) return sendText(sock, from, "[ x_x ] Ese número de grupo no existe kashira. Usa #allg para ver la lista.", msg);
    const gname = groupTarget.meta?.subject || db.groupNames?.[groupTarget.id] || groupTarget.id;

    if (isOff) {
      if (db.userLuckPct[targetNum]?.groups) delete db.userLuckPct[targetNum].groups[groupTarget.id];
      saveDB(db);
      return await sock.sendMessage(from, { text: `[ (¬‿¬) ] Suerte desactivada kashira para @${targetNum} en *${gname}*.`, mentions: [targetJid] }, { quoted: msg });
    }
    db.userLuckPct[targetNum] = db.userLuckPct[targetNum] || {};
    db.userLuckPct[targetNum].groups = db.userLuckPct[targetNum].groups || {};
    db.userLuckPct[targetNum].groups[groupTarget.id] = pct;
    saveDB(db);
    await sock.sendMessage(from, { text: `[ (¬‿¬) ] Suerte activada kashira para @${targetNum}: *${pct}%* solo en *${gname}*.`, mentions: [targetJid] }, { quoted: msg });
  }

  // ══════════════════════════════
  //    BLOQUE DE ERROR (ELSE FINAL)
  // ══════════════════════════════
  else {
    const errorMp4Path = './gifs/error.mp4'; // Cambiamos a .mp4

    if (fs.existsSync(errorMp4Path)) {
      await sock.sendMessage(from, {
        video: fs.readFileSync(errorMp4Path),
        mimetype: 'video/mp4', // ¡Esto es clave!
        gifPlayback: true,     // Esto le dice a WhatsApp que lo reproduzca como GIF
        caption: `*⌞ ERROR (⁠・⁠o⁠・⁠) ⌝*\n\n(=⁠_⁠=) *${body}* no es un comando válido, Usa *#help* para ver la lista de comandos.`
      }, { quoted: msg });
    } else {
      // Por si acaso, si no encuentra el mp4, envía texto
      await sendText(sock, from, `*⌞ ERROR (⁠・⁠o⁠・⁠) ⌝*\n\n(=⁠_⁠=) *${body}* no es un comando válido.`, msg);
    }
  }
}
// ─── BIENVENIDA DE NUEVOS MIEMBROS ────────────────────────────────────────────
function getKaomoji(pct) {
  if (pct < 20)  return "(._.)";
  if (pct < 40)  return "(^_^)";
  if (pct < 60)  return "(o^.^o)";
  if (pct < 75)  return "(O_O)";
  if (pct < 90)  return "(*O*)";
  return "(((*°▽°*)))";
}

async function animatePct(sock, from, quoted, lines, pct, gifPath, mentions = []) {
  const buildText = (p) => lines.replace("{pct}", p).replace("{kao}", getKaomoji(p));

  // Se manda directamente el resultado final (video+caption o solo texto) en
  // un único mensaje. Antes se mandaba en 0% y se intentaba "animar" editando
  // el mensaje varias veces (edit: sent.key), pero esas ediciones no se
  // aplicaban (Baileys las ignoraba) y el mensaje se quedaba pegado en 0%.
  const hasVideo = gifPath && fs.existsSync(gifPath);
  if (hasVideo) {
    await sock.sendMessage(from, {
      video: fs.readFileSync(gifPath),
      gifPlayback: true,
      caption: buildText(pct),
      mentions,
    }, { quoted });
  } else {
    await sock.sendMessage(from, { text: buildText(pct), mentions }, { quoted });
  }
}

async function handleGroupUpdate(sock, update) {
  const db = loadDB();
  const { id, participants, action } = update;
  if (action !== "add" && action !== "remove") return;

  const isJoin = action === "add";
  const enabledMap = isJoin ? db.welcomeEnabled : db.byeEnabled;
  if (!enabledMap?.[id]) return;

  const label = isJoin ? "WELCOME" : "BYE";
  const msgMap = isJoin ? db.welcomeMsg : db.byeMsg;
  const imgMap = isJoin ? db.welcomeImg : db.byeImg;
  const defaultText = isJoin ? DEFAULT_WELCOME_MSG : DEFAULT_BYE_MSG;

  let meta = null;
  try {
    meta = await sock.groupMetadata(id);
  } catch (e) {
    console.error(`[${label}] No se pudo obtener groupMetadata, se continúa sin nombre de grupo:`, e.message);
  }
  const subject = meta?.subject || "el grupo";

  for (const participant of participants) {
    const jid = typeof participant === "string" ? participant : participant.jid || participant.id || String(participant);
    const num = jid.split("@")[0];
    let eventText = msgMap?.[id] || defaultText;
    eventText = eventText.replace(/{user}/g, `@${num}`).replace(/{grupo}/g, subject);

    const localImgPath = imgMap?.[id];

    try {
      if (localImgPath && fs.existsSync(localImgPath)) {
        const imgBuf = fs.readFileSync(localImgPath);
        await sock.sendMessage(id, { image: imgBuf, caption: eventText, mentions: [jid] });
      } else {
        await sock.sendMessage(id, { text: eventText, mentions: [jid] });
      }
    } catch (e) {
      console.error(`[${label}] Error al enviar mensaje:`, e.message);
    }
  }
}

// ─── Menú de bienvenida al unirse a un grupo nuevo ────────────────────────────
// Se manda en cuanto el bot entra a un grupo: explica el prefijo, avisa que
// necesita admin en los próximos 5 minutos (o se sale sola), recuerda que está
// en beta, reconoce al owner y muestra el menú completo de comandos por
// categoría (reutilizando MENU.main, que ya tiene el estilo característico).
function buildFirstJoinMenu(groupCount) {
  const minutos = Math.round(ADMIN_GRACE_MS / 60000);
  const header = `*⌞ Beatrice [Re:zero] ⌝*

[ (⁠｡⁠•̀⁠ᴗ⁠-⁠)⁠✧ ] ¡Hola a todos, gracias por invitarme kashira! Soy Beatrice, un bot de WhatsApp.

(°Δ°) *IMPORTANTE:* denme *administrador* dentro de los próximos *${minutos} minutos*, o me salgo del grupo automáticamente kashira. Necesito ser admin para que funcionen mis herramientas de moderación (warns, antilink, antispam, #on/#off, etc.).

(o^-')b Estoy en fase *BETA*, así que puede que encuentres algún bug — repórtalo con *#bug [descripción]* kashira.

→ Mi prefijo en este grupo es: *${CONFIG.prefix}*
→ Mi owner es: *${CONFIG.ownerName}*, cualquier duda contáctalo directamente kashira.
→ Ahora mismo estoy activa en *${groupCount}* grupos kashira.

Aquí abajo está la lista completa de mis comandos por categoría (づ｡◕‿‿◕｡)づ:
━━━━━━━━━━━━━━━━`;

  return `${header}\n\n${MENU.main}`;
}

// Revisa si el bot mismo es admin en el grupo. Si no lo es, avisa y sale.
async function checkSelfAdminOrLeave(sock, groupId) {
  try {
    const meta = await sock.groupMetadata(groupId).catch(() => null);
    if (!meta) return; // ya no estamos en el grupo o no se pudo consultar, no hacemos nada

    const botNum = sock.user.id.split(":")[0].split("@")[0];
    const me = meta.participants.find(p => {
      const pId = typeof p.id === "string" ? p.id : "";
      const pNum = pId.split("@")[0].split(":")[0];
      const pnNum = (p.pn || p.phoneNumber || "").replace(/\D/g, "");
      return pNum === botNum || pnNum === botNum;
    });

    const amAdmin = me && (me.admin === "admin" || me.admin === "superadmin");
    if (amAdmin) return; // todo bien, nos quedamos

    await sock.sendMessage(groupId, {
      text: `[ (T_T) ] No recibí administrador a tiempo kashira, así que me salgo del grupo. Si quieren que me quede, vuelvan a agregarme y háganme admin dentro de los primeros ${Math.round(ADMIN_GRACE_MS / 60000)} minutos~`
    }).catch(() => {});
    await sock.groupLeave(groupId).catch(e => console.error("[AUTO-LEAVE] No se pudo salir del grupo:", e.message));
  } catch (e) {
    console.error("[AUTO-LEAVE] Error al verificar admin:", e.message);
  }
}

// Se dispara cuando el bot es agregado a un grupo: manda el menú de bienvenida
// y programa la verificación de admin a los 5 minutos.
async function handleBotJoinedGroup(sock, groupId) {
  // ── Deduplicar entre eventos ──
  // Baileys a veces dispara tanto "group-participants.update" (action:add del
  // propio bot) como "groups.upsert" para la misma entrada a un grupo, y a
  // veces solo uno de los dos. Escuchamos ambos (ver abajo) pero usamos este
  // flag para asegurarnos de mandar el menú una sola vez por entrada real.
  const dedupDb = loadDB();
  dedupDb.welcomedGroups = dedupDb.welcomedGroups || {};
  if (dedupDb.welcomedGroups[groupId]) return;
  dedupDb.welcomedGroups[groupId] = true;
  dedupDb.groupJoinedAt = dedupDb.groupJoinedAt || {};
  dedupDb.groupJoinedAt[groupId] = Date.now();
  saveDB(dedupDb);

  let groupCount = 1;
  let allGroups = {};
  try {
    allGroups = await sock.groupFetchAllParticipating();
    groupCount = Object.keys(allGroups || {}).length || 1;
  } catch (e) {
    console.error("[NEW GROUP] No se pudo contar los grupos:", e.message);
  }

  let meta = null;
  try {
    meta = await sock.groupMetadata(groupId);
  } catch (e) {
    console.error("[NEW GROUP] No se pudo obtener metadata del grupo:", e.message);
  }

  // ── Deduplicar el menú de bienvenida dentro de una misma comunidad ──
  // Cuando aceptamos una invitación a una comunidad, WhatsApp nos une solo a
  // varios subgrupos "por defecto" de golpe, disparando este evento una vez
  // por cada uno. Para no repetir el menú completo en cada subgrupo, solo lo
  // mandamos si NO estamos ya en otro subgrupo (no-avisos) de esa comunidad.
  // El grupo de "Avisos" (announce) es la excepción: ahí siempre se manda.
  const isAnnouncement = meta?.announce === true;
  const belongsToCommunity = !!meta?.linkedParent;

  let alreadyInCommunity = false;
  if (belongsToCommunity && !isAnnouncement) {
    alreadyInCommunity = Object.values(allGroups || {}).some(
      (g) => g.id !== groupId && g.linkedParent === meta.linkedParent && !g.announce
    );
  }

  if (!alreadyInCommunity) {
    try {
      const menuText = buildFirstJoinMenu(groupCount);
      // Le ponemos la foto de perfil del bot al menú de bienvenida. Si el bot no
      // tiene foto de perfil puesta, se cae de vuelta a mandar solo el texto.
      const myPfpUrl = await sock.profilePictureUrl(sock.user.id, "image").catch(() => null);
      if (myPfpUrl) {
        await sock.sendMessage(groupId, { image: { url: myPfpUrl }, caption: menuText });
      } else {
        await sock.sendMessage(groupId, { text: menuText });
      }
    } catch (e) {
      console.error("[NEW GROUP] Error al mandar el menú de bienvenida:", e.message);
    }
  } else {
    console.log(`[NEW GROUP] Menú de bienvenida omitido en ${groupId}: ya estoy en otro subgrupo (no-avisos) de esta comunidad.`);
  }

  setTimeout(() => {
    checkSelfAdminOrLeave(sock, groupId).catch(e => console.error("[AUTO-LEAVE] Error:", e.message));
  }, ADMIN_GRACE_MS);
}

// ─── Verificación automática de cumpleaños ────────────────────────────────────
// Revisa una vez al día (protegido con db.lastBirthdayCheckDate) los perfiles de
// cada grupo con #birthday activo, y felicita a quien cumpla años hoy kashira.
async function checkBirthdays(sock) {
  const db = loadDB();
  const todayStr = new Date().toLocaleDateString("es-MX", { timeZone: "America/Mexico_City" });
  if (db.lastBirthdayCheckDate === todayStr) return; // ya se corrió hoy

  const now = new Date();
  const todayDay = now.toLocaleString("es-MX", { timeZone: "America/Mexico_City", day: "2-digit" });
  const todayMonth = now.toLocaleString("es-MX", { timeZone: "America/Mexico_City", month: "2-digit" });
  const currentYear = Number(now.toLocaleString("es-MX", { timeZone: "America/Mexico_City", year: "numeric" }));

  const enabledGroups = Object.keys(db.birthdayEnabled || {}).filter(g => db.birthdayEnabled[g]);

  for (const gid of enabledGroups) {
    let meta;
    try {
      meta = await sock.groupMetadata(gid);
      updateLidMapFromMeta(meta);
    } catch (e) {
      continue;
    }

    for (const p of meta.participants) {
      try {
        const resolved = resolveToPN(p.id);
        const num = resolved.split("@")[0].split(":")[0];
        const prof = db.profiles?.[num];
        if (!prof?.birth) continue;

        const [d, m, y] = prof.birth.split("/");
        if (d !== todayDay || m !== todayMonth) continue;
        if (prof.lastBirthdayYear === currentYear) continue; // ya felicitado este año

        prof.lastBirthdayYear = currentYear;
        saveDB(db);

        const edad = y ? currentYear - Number(y) : "??";
        let birthdayText = db.birthdayMsg?.[gid] || DEFAULT_BIRTHDAY_MSG;
        birthdayText = birthdayText.replace(/{user}/g, `@${num}`).replace(/{grupo}/g, meta.subject).replace(/{edad}/g, edad);

        const localImgPath = db.birthdayImg?.[gid];

        if (localImgPath && fs.existsSync(localImgPath)) {
          const imgBuf = fs.readFileSync(localImgPath);
          await sock.sendMessage(gid, { image: imgBuf, caption: birthdayText, mentions: [resolved] });
        } else {
          await sock.sendMessage(gid, { text: birthdayText, mentions: [resolved] });
        }
      } catch (e) {
        console.error("[BIRTHDAY] Error al procesar participante:", e.message);
      }
    }
  }

  db.lastBirthdayCheckDate = todayStr;
  saveDB(db);
}

function question(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(prompt, (ans) => { rl.close(); resolve(ans.trim()); }));
}

// ─── CONEXIÓN PRINCIPAL ───────────────────────────────────────────────────────
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth_info");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  let pairingRequested = false;

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr && !pairingRequested && !sock.authState.creds.registered) {
      pairingRequested = true;
      let phoneNumber = await question(
        "\n📱 Número de WhatsApp (ej: 5219991234567):\n→ "
      );
      phoneNumber = phoneNumber.replace(/\D/g, "");
      if (!phoneNumber || phoneNumber.length < 10) {
        process.exit(1);
      }
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        const formatted = code.match(/.{1,4}/g).join("-");
        console.log(`\n🔑 CÓDIGO: ${formatted}\n`);
      } catch (err) {
        process.exit(1);
      }
    }

    if (connection === "close") {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const isConflict = code === 440 || lastDisconnect?.error?.message?.includes("conflict");
      const shouldReconnect = code !== DisconnectReason.loggedOut && !isConflict;
      if (isConflict) {
        console.log("⚠️ Conflicto de sesión detectado. Esperando 5s antes de reconectar...");
        setTimeout(() => { pairingRequested = false; startBot(); }, 5000);
      } else if (shouldReconnect) {
        pairingRequested = false;
        startBot();
      }
    }

    if (connection === "open") {
      BOT_NUMBER = sock.user.id.split(":")[0].split("@")[0];
      console.log(`\n✅ Conectado con éxito kashira! (owner detectado: ${BOT_NUMBER})`);
      // Llenamos el mapa LID→PN de todos los grupos de una vez, para que los
      // perfiles/comandos no fallen justo después de reiniciar el bot.
      try {
        const allGroups = await sock.groupFetchAllParticipating();
        for (const gid of Object.keys(allGroups || {})) {
          updateLidMapFromMeta(allGroups[gid]);
        }
        console.log(`[LID MAP] Precargado con ${Object.keys(allGroups || {}).length} grupo(s).`);
      } catch (e) {
        console.error("[LID MAP] No se pudo precargar (no crítico):", e.message);
      }

      // Revisa cumpleaños al conectar y luego cada 30 minutos (la función se
      // auto-protege para no felicitar dos veces el mismo día).
      checkBirthdays(sock).catch(e => console.error("[BIRTHDAY] Error inicial:", e.message));
      setInterval(() => {
        checkBirthdays(sock).catch(e => console.error("[BIRTHDAY] Error periódico:", e.message));
      }, 30 * 60 * 1000);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message) continue;
      try {
        updateLidMapFromMsg(msg);
        // Conteo de mensajes para perfiles
        const mFrom = msg.key.remoteJid;
        const mIsGroup = mFrom?.endsWith("@g.us");
        if (mIsGroup && !msg.key.fromMe) {
          const mSenderRaw = msg.key.participant || mFrom;
          const mDb = loadDB();
          let mDirty = false;
          const mSenderPN = resolveToPN(mSenderRaw);
          // Bug corregido: antes mNum salía de mSenderRaw (el JID crudo), que en muchos casos
          // es un @lid (identificador de privacidad) y NO el número de teléfono real. Eso hacía
          // que el texto mostrara "@<id-lid>" mientras que el array de mentions apuntaba al JID
          // de teléfono real (mSenderPN) — un mismatch que rompía el tag en warns, automod,
          // retos, etc. Ahora mNum siempre sale del JID ya resuelto, así el texto visible
          // ("@número") y el mentions[] siempre coinciden.
          const mNum = mSenderPN.split("@")[0].split(":")[0];
          const mPlainBody = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || "").trim();

          // ── #afk: si el que escribe estaba AFK, se le quita el estado y se avisa ──
          if (mDb.afk?.[mNum]) {
            const afkInfo = mDb.afk[mNum];
            delete mDb.afk[mNum];
            mDirty = true;
            await sock.sendMessage(mFrom, {
              text: `[ (o^-')b ] @${mNum} ya volvió kashira (estuvo AFK ${fmtElapsedLong(Date.now() - afkInfo.since)}).`,
              mentions: [mSenderPN]
            }).catch(() => {});
          }

          // ── #afk: si mencionan o responden a alguien que está AFK, avisar ──
          if (mPlainBody && mDb.afk) {
            const mMentioned = (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []).map(j => resolveToPN(j).split("@")[0].split(":")[0]);
            const mQuotedP = msg.message?.extendedTextMessage?.contextInfo?.participant;
            const mAfkTargets = new Set(mMentioned);
            if (mQuotedP) mAfkTargets.add(resolveToPN(mQuotedP).split("@")[0].split(":")[0]);
            for (const tNum of mAfkTargets) {
              if (tNum === mNum) continue;
              const info = mDb.afk[tNum];
              if (info) {
                await sock.sendMessage(mFrom, {
                  text: `[ (-_-) ] @${tNum} está AFK desde hace ${fmtElapsedLong(Date.now() - info.since)}${info.reason ? `: _${info.reason}_` : ""}.`,
                  mentions: [tNum + "@s.whatsapp.net"]
                }).catch(() => {});
              }
            }
          }

          // ── Efectos secretos temporales: #echo / #mirror ──
          // Reaccionan a CUALQUIER mensaje normal de esa persona en ese grupo (no solo
          // comandos) — por eso se filtra que NO empiece con el prefijo, para no meterse
          // encima de la respuesta normal de un comando real.
          if (mPlainBody && !mPlainBody.startsWith(CONFIG.prefix)) {
            const mEff = mDb.secretEffects?.[mFrom]?.[mNum];
            if (mEff?.echoUntil && Date.now() < mEff.echoUntil) {
              await sock.sendMessage(mFrom, { text: owoifyText(mPlainBody) }, { quoted: msg }).catch(() => {});
            } else if (mEff?.mirror?.remaining > 0) {
              mEff.mirror.remaining--;
              if (mEff.mirror.remaining <= 0) delete mEff.mirror;
              mDirty = true;
              await sock.sendMessage(mFrom, { text: mirrorTransform(mPlainBody) }, { quoted: msg }).catch(() => {});
            }
          }

          // ── #alertme: vigilancia global por palabra clave (lista, todos los grupos) ──
          // A diferencia de los efectos de arriba, esto SÍ revisa comandos también (por
          // si alguien menciona la palabra dentro de uno), y nunca se dispara con
          // mensajes del propio owner.
          if (mPlainBody && mDb.alertWords?.length && !isOwner(mSenderPN)) {
            const mNormBody = normalizeText(mPlainBody);
            const mMatched = mDb.alertWords.find(w => mNormBody.includes(normalizeText(w)));
            if (mMatched) {
              const mGname = mDb.groupNames?.[mFrom] || mFrom;
              await sock.sendMessage(BOT_NUMBER + "@s.whatsapp.net", {
                text: `*⌞ #alertme: "${mMatched}" ⌝*\n━━━━━━━━━━━━━━━━\n\nGrupo: ${mGname}\nDe: @${mNum}\n\n"${mPlainBody}"\n━━━━━━━━━━━━━━━━`,
                mentions: [mSenderPN]
              }).catch(() => {});
            }
          }

          // ── #shadowlog: graba TODO lo que escriba esa persona (no solo comandos)
          // mientras esté activo. Se lee después con #readlog. ──
          const mShadow = mDb.shadowLogActive?.[mFrom]?.[mNum];
          if (mShadow && Date.now() < mShadow.until && mPlainBody) {
            mDb.shadowLogs = mDb.shadowLogs || {};
            mDb.shadowLogs[mNum] = mDb.shadowLogs[mNum] || [];
            mDb.shadowLogs[mNum].push({ groupId: mFrom, text: mPlainBody, ts: Date.now() });
            // Tope para que no crezca sin límite: se queda con las últimas 300 líneas.
            if (mDb.shadowLogs[mNum].length > 300) {
              mDb.shadowLogs[mNum] = mDb.shadowLogs[mNum].slice(-300);
            }
            mDirty = true;
          }

          // ── #trivia / #math: cualquiera en el grupo puede responder con texto normal ──
          if (pendingChallenges[mFrom] && mPlainBody && !mPlainBody.startsWith(CONFIG.prefix)) {
            const challenge = pendingChallenges[mFrom];
            const isCorrect = challenge && (
              challenge.type === "trivia"
                ? answerCloseEnough(mPlainBody, challenge.answer) // #trivia: con margen de error
                : normalizeText(mPlainBody) === challenge.answer   // #math: exacto, son números
            );
            if (isCorrect) {
              clearChallenge(mFrom);
              const hasProfile = !!mDb.profiles?.[mNum];

              if (challenge.type === "trivia") {
                // #trivia: ahora da dinero real (antes solo XP cosmética, que no
                // desbloquea nada) además de la XP de bono.
                let xpRes = null;
                const trivEco = hasProfile ? getEco(mDb, mFrom, mNum) : null;
                if (hasProfile) {
                  xpRes = addXp(mDb, mNum, challenge.xpReward);
                  trivEco.wallet += challenge.moneyReward;
                  trivEco.lastActive = Date.now();
                }
                saveDB(mDb);
                await sock.sendMessage(mFrom, {
                  text: `[ (๑˃ᴗ˂)ﻭ ] @${mNum} respondió bien kashira!${hasProfile ? `\n\nGanó *${fmtM(challenge.moneyReward)}* y *${challenge.xpReward} XP*` : "\n\n_Crea un perfil con #createprofile para poder ganar algo kashira._"}`,
                  mentions: [mSenderPN]
                });
                if (xpRes?.leveledUp) {
                  await sock.sendMessage(mFrom, {
                    text: `[ (☆^ー^) ] ¡@${mNum} subiste a *nivel ${xpRes.level}* kashira! ✧`,
                    mentions: [mSenderPN]
                  }).catch(() => {});
                }
              } else {
                // #math: recompensa económica, como antes
                const winnerEco = hasProfile ? getEco(mDb, mFrom, mNum) : null;
                if (winnerEco) {
                  winnerEco.wallet += challenge.reward;
                  winnerEco.lastActive = Date.now();
                }
                saveDB(mDb);
                await sock.sendMessage(mFrom, {
                  text: `[ (๑˃ᴗ˂)ﻭ ] @${mNum} respondió bien kashira!${winnerEco ? `\n\nGanó *${fmtM(challenge.reward)}*` : "\n\n_Crea un perfil con #createprofile para poder cobrar premios kashira._"}`,
                  mentions: [mSenderPN]
                });
              }
            }
          }

          // ── Selección pendiente de #lyrics: solo responde quien buscó, con un número ──
          if (pendingLyrics[mFrom] && pendingLyrics[mFrom].requester === mSenderPN) {
            const idx = parseInt(mPlainBody);
            const pending = pendingLyrics[mFrom];
            if (!isNaN(idx) && idx >= 1 && idx <= pending.options.length) {
              clearLyricsPending(mFrom);
              const choice = pending.options[idx - 1];
              await sendLyricsResult(sock, mFrom, msg, choice.artist, choice.title);
            }
          }

          // ── Anti-X: moderación automática (antiaudio/antisticker/antiimage/antivideo/antibot/antispam) ──
          // Se desenvuelve el mensaje (efímero/viewOnce) antes de detectar el tipo de contenido,
          // así antiaudio/antisticker/antiimage/antivideo también funcionan con mensajes envueltos.
          const mUnwrapped = unwrapMessage(msg.message);
          const mContentType = getContentType(mUnwrapped);
          const MEDIA_TOGGLE_MAP = { audioMessage: "antiaudio", stickerMessage: "antisticker", imageMessage: "antiimage", videoMessage: "antivideo" };
          const activeMediaToggle = MEDIA_TOGGLE_MAP[mContentType];
          // Prefijos comunes de otros bots de WhatsApp, para evitar que Beatrice y otro bot choquen en el mismo grupo.
          const looksLikeOtherBotCmd = /^[.!/,$%](?!\s|$)/.test(mPlainBody);

          const needsAntiModCheck =
            (activeMediaToggle && mDb[activeMediaToggle]?.[mFrom]) ||
            (mDb.antibot?.[mFrom] && looksLikeOtherBotCmd) ||
            mDb.antispam?.[mFrom];

          if (needsAntiModCheck) {
            const mSenderIsAdmin = await isAdmin(sock, mFrom, mSenderPN).catch(() => false);
            if (!mSenderIsAdmin) {
              if (activeMediaToggle && mDb[activeMediaToggle]?.[mFrom]) {
                await autoModDeleteAndWarn(sock, mDb, mFrom, mSenderPN, mNum, msg.key.id, `${ANTI_TOGGLES[activeMediaToggle].label} (contenido no permitido en este grupo)`);
              } else if (mDb.antibot?.[mFrom] && looksLikeOtherBotCmd) {
                await autoModDeleteAndWarn(sock, mDb, mFrom, mSenderPN, mNum, msg.key.id, "Antibot (prefijo de otro bot detectado)");
              } else if (mDb.antispam?.[mFrom]) {
                const spamKey = `${mFrom}:${mNum}`;
                const now = Date.now();
                const recent = (spamTracker[spamKey] || []).filter(t => now - t < SPAM_WINDOW_MS);
                recent.push(now);
                spamTracker[spamKey] = recent;
                if (recent.length >= SPAM_MAX_MSGS) {
                  spamTracker[spamKey] = [];
                  await autoModDeleteAndWarn(sock, mDb, mFrom, mSenderPN, mNum, msg.key.id, "Antispam (mensajes repetidos muy seguido)");
                }
              }
            }
          }

          // Antilink: borra automáticamente links de invitación a otros grupos de WhatsApp
          if (mDb.antilink?.[mFrom]) {
            const unwrapped = unwrapMessage(msg.message);
            const linkBody = unwrapped?.conversation ||
              unwrapped?.extendedTextMessage?.text ||
              unwrapped?.imageMessage?.caption ||
              unwrapped?.videoMessage?.caption || "";
            const hasLink = /chat\.whatsapp\.com\/[A-Za-z0-9]+/i.test(linkBody);
            if (hasLink) {
              const mSenderPN = resolveToPN(mSenderRaw);
              const senderIsAdmin = await isAdmin(sock, mFrom, mSenderPN).catch(() => false);
              if (!senderIsAdmin) {
                // Unificado con el resto de los toggles: usa la misma función que antiaudio/antibot/etc,
                // así el "Por:" de las advertencias siempre dice "Sistema (AutoMod)" sin importar qué
                // toggle disparó la advertencia (antes decía "Sistema (Antilink)", inconsistente).
                const ok = await autoModDeleteAndWarn(sock, mDb, mFrom, mSenderPN, mNum, msg.key.id, "Antilink (link de invitación a otro grupo)");
                if (ok) console.log(`[ANTILINK] Mensaje de ${mNum} borrado y advertido con éxito.`);
              }
            }
          }
          if (mDb.economy?.[mFrom]?.[mNum]) {
            mDb.economy[mFrom][mNum].lastActive = Date.now();
            mDirty = true;
          }
          let mLevelUp = null;
          if (mDb.profiles?.[mNum]) {
            mDb.profiles[mNum].stats = mDb.profiles[mNum].stats || {};
            mDb.profiles[mNum].stats.totalCmds = mDb.profiles[mNum].stats.totalCmds || 0;

            mDb.profiles[mNum].groupStats = mDb.profiles[mNum].groupStats || {};
            mDb.profiles[mNum].groupStats[mFrom] = mDb.profiles[mNum].groupStats[mFrom] || { msgs: 0, cmds: 0 };
            mDb.profiles[mNum].groupStats[mFrom].msgs++;
            mDb.profiles[mNum].groupStats[mFrom].lastActive = Date.now();

            const mBody = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || "";
            const mIsCmd = mBody.trim().startsWith(CONFIG.prefix);
            if (mIsCmd) {
              mDb.profiles[mNum].groupStats[mFrom].cmds++;
              mDb.profiles[mNum].groupStats[mFrom].lastCmdActive = Date.now();
              mDb.profiles[mNum].stats.totalCmds++;
            }

            // ── XP: única fuente de experiencia — un poco por mensaje, un poco más por usar un comando ──
            const mXpRes = addXp(mDb, mNum, mIsCmd ? 3 : 1);
            if (mXpRes?.leveledUp) mLevelUp = mXpRes.level;

            const mNowTs = Date.now();
            mDb.profiles[mNum].stats.lastSeenTs = mNowTs;

            mDirty = true;
          }
          if (mDirty) saveDB(mDb);

          if (mLevelUp) {
            try {
              await sock.sendMessage(mFrom, {
                text: `[ (☆^ー^) ] ¡@${mNum} subiste a *nivel ${mLevelUp}* kashira! ✧`,
                mentions: [mSenderPN]
              });
            } catch {}
          }
        } else if (!mIsGroup && !msg.key.fromMe && mFrom?.endsWith("@s.whatsapp.net")) {
          // ── Saludo automático en privado: solo si NO es un comando, y con cooldown ──
          // para no repetir el mismo mensaje en cada línea que la persona mande.
          const mDmBody = (
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption || ""
          ).trim();
          if (!mDmBody.startsWith(CONFIG.prefix)) {
            const mDb = loadDB();
            mDb.dmGreetLast = mDb.dmGreetLast || {};
            const mDmNum = mFrom.split("@")[0].split(":")[0];
            const mNowTs = Date.now();
            const DM_GREET_COOLDOWN = 12 * 60 * 60 * 1000; // 12h
            if (mNowTs - (mDb.dmGreetLast[mDmNum] || 0) > DM_GREET_COOLDOWN) {
              mDb.dmGreetLast[mDmNum] = mNowTs;
              saveDB(mDb);
              try {
                await sock.sendMessage(mFrom, {
                  text: `[ (o^-')b ] ¡Hola kashira! Soy *Beako*, un bot de WhatsApp, no una persona real kashira.\n\nSi quieres que me una a tu grupo o comunidad, mándame *#invite <link de invitación>*.\n\nUsa *#help* para ver todos mis comandos kashira.`
                });
              } catch (e) {
                console.error("[DM-GREET] No se pudo enviar el saludo:", e.message);
              }
            }
          }
        }
        await handleCommand(sock, msg);
      } catch (e) {
        console.error("[ERROR]:", e.message);
      }
    }
  });

  sock.ev.on("group-participants.update", async (update) => {
    try {
      // Actualizar mapa LID→PN desde el evento
      if (update.participants) {
        for (const p of update.participants) {
          if (typeof p === "object" && p.id?.includes("@lid") && (p.pn || p.phoneNumber)) {
            storeLidPn(p.id, p.pn || p.phoneNumber);
          }
        }
      }

      // ── ¿El bot mismo fue agregado a un grupo? Dispara el menú de bienvenida ──
      if (update.action === "add" && Array.isArray(update.participants)) {
        const botNum = sock.user.id.split(":")[0].split("@")[0];
        const botWasAdded = update.participants.some(p => {
          const pId = typeof p === "string" ? p : (p.id || p.jid || String(p));
          const pNum = pId.split("@")[0].split(":")[0];
          const pnNum = (typeof p === "object" ? (p.pn || p.phoneNumber || "") : "").replace(/\D/g, "");
          return pNum === botNum || pnNum === botNum;
        });
        if (botWasAdded) {
          await handleBotJoinedGroup(sock, update.id);
          return; // evitamos también procesarlo como un welcome normal de "un miembro se unió"
        }
      }

      // ── ¿El bot mismo fue sacado del grupo? Limpiamos el flag de bienvenida ──
      // para que, si lo vuelven a meter después, sí se mande el menú otra vez.
      if (update.action === "remove" && Array.isArray(update.participants)) {
        const botNum = sock.user.id.split(":")[0].split("@")[0];
        const botWasRemoved = update.participants.some(p => {
          const pId = typeof p === "string" ? p : (p.id || p.jid || String(p));
          const pNum = pId.split("@")[0].split(":")[0];
          const pnNum = (typeof p === "object" ? (p.pn || p.phoneNumber || "") : "").replace(/\D/g, "");
          return pNum === botNum || pnNum === botNum;
        });
        if (botWasRemoved) {
          const db = loadDB();
          if (db.welcomedGroups?.[update.id]) {
            delete db.welcomedGroups[update.id];
            saveDB(db);
          }
          return;
        }
      }

      await handleGroupUpdate(sock, update);
    } catch (e) {
      console.error("[ERROR]:", e.message);
    }
  });

  // ── Respaldo: "groups.upsert" ──
  // Cuando nos agregan a un grupo, Baileys casi siempre dispara este evento
  // también (a veces "group-participants.update" no llega o llega tarde/incompleto,
  // sobre todo si nos agregan por link de invitación en vez de que un admin
  // nos agregue directo). handleBotJoinedGroup ya deduplica con welcomedGroups,
  // así que no hay riesgo de mandar el menú dos veces si ambos eventos disparan.
  sock.ev.on("groups.upsert", async (groups) => {
    for (const g of groups || []) {
      try {
        if (!g?.id) continue;
        const stillIn = await sock.groupMetadata(g.id).catch(() => null);
        if (!stillIn) continue; // por si acaso ya no estamos ahí
        await handleBotJoinedGroup(sock, g.id);
      } catch (e) {
        console.error("[GROUPS.UPSERT] Error:", e.message);
      }
    }
  });

}

startBot().catch(console.error);

