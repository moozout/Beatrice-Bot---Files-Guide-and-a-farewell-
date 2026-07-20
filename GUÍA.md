# Beatrice Bot — Bot de WhatsApp con Baileys

Bot de WhatsApp hecho en Node.js usando [Baileys](https://github.com/WhiskeySockets/Baileys). Incluye descargas (TikTok, YouTube, Facebook, Pinterest), stickers, moderación automática (antilink, antispam, etc.), sistema de perfiles, economía, juegos y más.

100% gratis y sin licencias: no hay comandos de token ni de activación por grupo, todos los grupos pueden usar el bot libremente. Tampoco hay ningún número "owner" fijo en el código — el owner (dueño con todos los permisos) es automáticamente el número de WhatsApp con el que vincules el bot.

>  Este bot funciona en tu propio dispositivo Android usando **Termux**. No necesitas un servidor ni VPS.

---

## Requisitos

- Un celular Android (con espacio libre y buena batería/conexión, ya que el bot debe quedarse corriendo).
- La app **Termux** (APK incluido en este repositorio / release — **no** instalar desde Play Store, esa versión está desactualizada y no funciona bien).
- Un número de WhatsApp para vincular el bot (recomendado: uno secundario, no tu número principal).

---

## 1. Instalar Termux

1. Descarga el APK de Termux desde este repositorio (sección [Releases](../../releases) o carpeta `/apk`).
2. Instálalo en tu celular (puede que Android te pida activar "Instalar apps de orígenes desconocidos").
3. Ábrelo. Deberías ver una terminal negra con texto verde/blanco.

---

## 2. Dar acceso al almacenamiento

Para que el bot pueda guardar sesión, descargas temporales, imágenes, etc., dale permiso de almacenamiento a Termux:

```bash
termux-setup-storage
```

Te va a saltar un permiso de Android — **acéptalo**. Esto crea una carpeta `~/storage` con accesos directos a tu almacenamiento (`~/storage/shared`, `~/storage/downloads`, etc.).

---

## 3. Crear la carpeta del bot

```bash
mkdir -p ~/beatrice-bot
cd ~/beatrice-bot
```

Coloca aquí el archivo `index.js` (y `package.json` si lo incluyes) que descargaste de este repositorio. Puedes usar una app de administrador de archivos para copiarlo a `~/storage/downloads` y luego moverlo, o clonarlo directo con `git` (ver paso siguiente).

### Opción alterna: clonar el repo directo con git
```bash
pkg install -y git
git clone https://github.com/TU-USUARIO/TU-REPOSITORIO.git ~/beatrice-bot
cd ~/beatrice-bot
```

---

## 4. Agregar la carpeta `gifs/`

El bot necesita estos videos para funcionar bien (comandos de la categoría **Juegos** y el video de error genérico). Deben ir dentro de una carpeta llamada `gifs/`, al mismo nivel que `index.js`:

```
tu-repo/
├── index.js
└── gifs/
    ├── ship.mp4
    ├── vs.mp4
    ├── mejor.mp4
    ├── rata.mp4
    ├── simp.mp4
    ├── iq.mp4
    ├── gay.mp4
    ├── lesbian.mp4
    ├── bisexual.mp4
    ├── freaky.mp4
    ├── otaku.mp4
    ├── funny.mp4
    └── error.mp4
```

Créala así dentro de la carpeta del bot:

```bash
mkdir -p gifs
```

Y copia ahí los 13 archivos `.mp4` (los mismos que vienen en este repositorio). Si a algún comando le falta su video, el bot simplemente responde solo con texto (no se cae), pero para la experiencia completa asegúrate de tenerlos todos.

> Nota: el video `preg.mp4` (categoría Perfil, comando `#preg`) **no** va en `gifs/`, ese se queda en la raíz junto a `index.js`.

---

## 5. Instalar todo lo necesario (un solo comando)

Parado dentro de la carpeta del bot (`~/beatrice-bot`), corre:

```bash
pkg update -y && pkg upgrade -y && pkg install -y nodejs git ffmpeg python && pip install -U yt-dlp && npm init -y && npm install @whiskeysockets/baileys axios @hapi/boom fluent-ffmpeg node-webpmux form-data
```

Esto instala:
| Herramienta | Para qué sirve |
|---|---|
| `nodejs` | Motor para correr el bot |
| `ffmpeg` | Procesar audio/video/stickers |
| `python` + `yt-dlp` | Descargar videos/audios de YouTube (`#yta`, `#ytv`) |
| `@whiskeysockets/baileys` | Conexión con WhatsApp |
| `axios` | Peticiones HTTP (descargas, QR, etc.) |
| `@hapi/boom` | Manejo de errores de conexión |
| `fluent-ffmpeg` | Wrapper de ffmpeg para Node |
| `node-webpmux` | Metadata (autor/nombre) de los stickers |
| `form-data` | Envío de archivos en peticiones (lector de QR) |

---

## 6. Correr el bot

```bash
node index.js
```

La primera vez te va a pedir vincular tu WhatsApp (escaneando un QR o con un código de emparejamiento). Una vez vinculado, la sesión queda guardada en la carpeta y no tendrás que volver a escanear (a menos que borres esa carpeta o cierres sesión desde el celular).

**Importante:** el número que vincules aquí se convierte automáticamente en el **owner** del bot (acceso total a todos los comandos), así que usa el número que quieras que tenga el control.

### Mantenerlo corriendo sin que se apague la pantalla
```bash
termux-wake-lock
node index.js
```

---

## 7. Reiniciar el bot en el futuro

Cada vez que quieras volver a prenderlo (sin reinstalar nada), solo necesitas:

```bash
cd ~/beatrice-bot
node index.js
```

---

##  Solución de problemas

- **"yt-dlp: command not found"**: corre de nuevo `pip install -U yt-dlp`.
- **Error al instalar `@whiskeysockets/baileys`**: prueba `npm install github:WhiskeySockets/Baileys`.
- **El bot se cierra al bloquear pantalla**: usa `termux-wake-lock` antes de `node index.js`, y desactiva la optimización de batería de Termux en Ajustes de Android.
- **No pide permiso de almacenamiento**: ve a Ajustes de Android > Apps > Termux > Permisos > Almacenamiento, actívalo manualmente y vuelve a correr `termux-setup-storage`.
- **Los comandos de Juegos (#ship, #vs, #gay, etc.) no mandan video**: revisa que la carpeta `gifs/` exista junto a `index.js` y que los archivos `.mp4` tengan exactamente esos nombres.

---

##  Aviso

Este bot usa una librería no oficial (Baileys) para conectarse a WhatsApp. Usarlo puede ir en contra de los Términos de Servicio de WhatsApp; úsalo bajo tu propio riesgo, de preferencia con un número secundario.

---

## Créditos

Bot creado por **MoozOut**. Basado en [Baileys](https://github.com/WhiskeySockets/Baileys).
