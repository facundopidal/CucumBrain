# Guía de Despliegue en Producción (Netbook Headless) - CucumBrain

Esta guía detalla los pasos para desplegar **CucumBrain** en modo desatendido (*headless*) dentro de una Samsung Netbook (Windows x86 / 32-bits, Node.js v18) para que el bot de Telegram y el indexador de Obsidian inicien automáticamente al encender el equipo sin necesidad de interacción manual.

---

## 📋 Requisitos Previos en la Netbook

1. **Node.js v18** instalado.
2. **Git** instalado.
3. **PM2** instalado globalmente:
   ```bash
   npm install -g pm2
   ```

---

## 🚀 Pasos de Instalación y Despliegue

### 1. Clonar el Repositorio e Instalar Dependencias
```bash
git clone <URL-DEL-REPOSITORIO> CucumBrain
cd CucumBrain
npm install --production
```

### 2. Configurar Variables de Entorno (`.env`)
Copia el archivo de ejemplo `.env.example` a `.env`:
```bash
copy .env.example .env
```
Edita `.env` y configura los valores reales de producción:
* `TELEGRAM_BOT_TOKEN`: Token obtenido de @BotFather.
* `TELEGRAM_ALLOWED_USER_ID`: Tu ID numérico de Telegram (para restringir el uso exclusivo a ti).
* `LLM_PROVIDER`: `gemini` (o `groq` / `openrouter`).
* `LLM_MODEL`: `gemini-1.5-flash` (o `llama-3.3-70b-versatile` en Groq).
* `GEMINI_API_KEY` o `LLM_API_KEY`: Tu clave API.
* `OBSIDIAN_VAULT_PATH`: Ruta absoluta a la carpeta de tu Bóveda de Obsidian en la Netbook (ej: `C:\Users\Usuario\Documents\ObsidianVault`).

### 3. Inicializar la Base de Datos SQLite
```bash
npm run db:init
```

---

## ⚙️ Gestión de Procesos con PM2

### Iniciar el servicio en segundo plano
```bash
npm run pm2:start
```

### Monitoreo y Logs
* **Ver logs en tiempo real:**
  ```bash
  npm run pm2:logs
  ```
* **Ver estado del proceso:**
  ```bash
  npx pm2 status
  ```
* **Reiniciar el bot:**
  ```bash
  npm run pm2:restart
  ```
* **Detener el bot:**
  ```bash
  npm run pm2:stop
  ```

---

## 🔄 Configurar Auto-Arranque al Iniciar Windows (Headless)

Para que CucumBrain se ejecute en segundo plano automáticamente cada vez que se encienda la Netbook:

1. Instala el módulo de inicio automático de PM2 para Windows:
   ```bash
   npm install -g pm2-windows-startup
   ```
2. Registra el servicio de inicio:
   ```bash
   pm2-startup install
   ```
3. Guarda el estado actual del proceso:
   ```bash
   pm2 save
   ```

¡Listo! CucumBrain estará corriendo 24/7 de forma ligera y transparente en tu Netbook.
