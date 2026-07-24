/**
 * PM2 configuration.
 *
 *   npm run build
 *   pm2 start ecosystem.config.cjs
 *   pm2 logs web-scraper
 *   pm2 save && pm2 startup      # survive reboots
 *
 * .cjs because package.json sets "type": "module" and PM2 loads this with require().
 */
module.exports = {
  apps: [
    {
      name: "web-scraper",
      script: "build/server.js",
      cwd: __dirname,
      instances: 1, // single instance: the job store and browser are in-process
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      // Chromium is memory hungry; restart before it can disturb neighbours.
      max_memory_restart: "1G",
      kill_timeout: 10000, // give the browser time to close on SIGTERM
      env: {
        NODE_ENV: "production",
        PORT: 3050,
        // Bind to loopback and put nginx in front, or set 0.0.0.0 + a token.
        HOST: "127.0.0.1",
        SCRAPER_OUTPUT_DIR: `${process.env.HOME || "/root"}/scraper-output`,
        SCRAPER_MAX_CONCURRENT_JOBS: 2,
        SCRAPER_LOCALE: "tr-TR",
        SCRAPER_TIMEZONE: "Europe/Istanbul",
        // SCRAPER_API_TOKEN: "buraya-uzun-rastgele-bir-token",
      },
      error_file: "logs/error.log",
      out_file: "logs/out.log",
      merge_logs: true,
      time: true,
    },
  ],
};
