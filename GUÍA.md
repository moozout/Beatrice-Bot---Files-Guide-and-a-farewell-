# Beatrice Bot — Bot de WhatsApp con Baileys

Bot de WhatsApp hecho en Node.js usando [Baileys](https://github.com/WhiskeySockets/Baileys). Incluye descargas (TikTok, YouTube, Facebook, Pinterest), stickers, moderación automática (antilink, antispam, etc.), sistema de perfiles, economía, juegos y más.

>  Este bot funciona en tu propio dispositivo Android usando **Termux**. No necesitas un servidor ni VPS.

---

## Requisitos

- Un celular Android (con espacio libre y buena batería/conexión, ya que el bot debe quedarse corriendo).
- La app **Termux** (APK incluido en este repositorio / release — **no** instalar desde Play Store, esa versión está desactualizada y no funciona bien).
- Un número de WhatsApp para vincular el bot (recomendado: uno secundario, no tu número principal).

---

## 1. Instalar Termux

1. Descarga el APK de Termux desde este repositorio (Descarga el F-droid.apk, despues, abre este link [https://f-droid.org/packages/com.termux/] y descarga termux actualizado ) o carpeta `/apk`).
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

##  4. Instalar todo lo necesario (un solo comando)

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

## ▶ 5. Correr el bot

```bash
node index.js
```

La primera vez te va a pedir vincular tu WhatsApp (escaneando un QR o con un código de emparejamiento). Una vez vinculado, la sesión queda guardada en la carpeta y no tendrás que volver a escanear (a menos que borres esa carpeta o cierres sesión desde el celular).

### Mantenerlo corriendo sin que se apague la pantalla
```bash
termux-wake-lock
node index.js
```

---

## 6. Reiniciar el bot en el futuro

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

---

##  Aviso

Este bot usa una librería no oficial (Baileys) para conectarse a WhatsApp. Usarlo puede ir en contra de los Términos de Servicio de WhatsApp; úsalo bajo tu propio riesgo, de preferencia con un número secundario.

---

## Créditos

Bot creado por **MoozOut**. Basado en [Baileys](https://github.com/WhiskeySockets/Baileys).

Unica forma de contacto: 
Discord: .mooz_.
WhatsApp: 523223783244
Por la cuenta actual de Github.
