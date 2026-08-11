"""
Drop-in self-healing for Scrapy spiders.

Scrapy runs in Python; the repair loop lives in Node, so this middleware is
the seam: it keeps your spider's last good rows in a JSONL file, and the
moment an item is missing a required field -- the first symptom of a redesign
-- it hands the job to scrape-heal's one-shot `repair` command, which
re-measures the live page in a browser, heals the selectors, and rewrites the
config file. Your spider reads that file each parse (see the Scrapy recipe in
docs/INTEGRATIONS.md) and picks up the fixed selectors on the next request.

Wire it up in settings.py:

    SPIDER_MIDDLEWARES = {
        "scrape_middleware.ScrapeHealMiddleware": 950,
    }

    # optional knobs (env vars or settings):
    SCRAPE_HEAL_CONFIG   = "scraper.config.json"              # where the selectors live
    SCRAPE_HEAL_BASELINE = ".scrape-heal/last-good.jsonl"     # last-good rows, kept here

Requires `scrape-heal` on PATH (`npm i -g scrape-heal`).
"""

import json
import os
import subprocess
import time

# How many good rows the baseline keeps. The most recent window is enough to
# anchor a repair -- the loop only needs a few known values per field.
BASELINE_CAP = 500

# Seconds between repair runs for one process. A broken site pings the repair
# CLI once, then waits -- the loop shouldn't fight a long outage every request.
REPAIR_COOLDOWN = 3600


class ScrapeHealMiddleware:
    def __init__(self, config_path, baseline_path, repair_cooldown=REPAIR_COOLDOWN):
        self.config_path = config_path
        self.baseline_path = baseline_path
        self.repair_cooldown = repair_cooldown
        self._last_repair_at = 0.0

    @classmethod
    def from_crawler(cls, crawler):
        return cls(
            config_path=crawler.settings.get("SCRAPE_HEAL_CONFIG", "scraper.config.json"),
            baseline_path=crawler.settings.get("SCRAPE_HEAL_BASELINE", ".scrape-heal/last-good.jsonl"),
        )

    # ------------------------------------------------------------ the hook

    def process_spider_output(self, response, result, spider):
        config = self._read_config()
        required = list((config or {}).get("fields", {}).keys()) or []
        for item in result:
            missing = [f for f in required if not str(item.get(f, "") or "").strip()]
            if missing:
                spider.logger.warning(
                    "scrape-heal: item is missing field(s) %s — the selectors may have broken",
                    missing,
                )
                if self._should_repair():
                    self._repair(spider)
            else:
                self._remember(item)
            yield item

    # --------------------------------------------------------------- repair

    def _should_repair(self):
        return time.time() - self._last_repair_at > self.repair_cooldown

    def _repair(self, spider):
        self._last_repair_at = time.time()
        spider.logger.warning(
            "scrape-heal: running one-shot repair on %s (baseline %s)",
            self.config_path,
            self.baseline_path,
        )
        if not os.path.exists(self.baseline_path):
            spider.logger.warning("scrape-heal: no baseline yet — nothing to repair against")
            return
        try:
            proc = subprocess.run(
                [
                    "scrape-heal", "repair",
                    "--config", self.config_path,
                    "--rows", self.baseline_path,
                ],
                capture_output=True,
                text=True,
                timeout=180,
            )
            if proc.returncode == 0:
                spider.logger.warning(
                    "scrape-heal: repaired — new selectors written to %s", self.config_path
                )
            else:
                detail = (proc.stderr or proc.stdout or "").strip()[-400:]
                spider.logger.error(
                    "scrape-heal: repair failed (%s) — nothing modified: %s",
                    proc.returncode,
                    detail,
                )
        except (OSError, subprocess.TimeoutExpired) as exc:
            spider.logger.error("scrape-heal: could not run repair: %s", exc)

    # ------------------------------------------------------------ baseline

    def _remember(self, item):
        try:
            os.makedirs(os.path.dirname(self.baseline_path) or ".", exist_ok=True)
            with open(self.baseline_path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(item) + "\n")
            self._cap_baseline()
        except OSError:
            pass

    def _cap_baseline(self):
        """Keep only the most recent BASELINE_CAP rows — a repair only needs a
        handful of known values, and an unbounded file is a slow leak."""
        try:
            with open(self.baseline_path, "r", encoding="utf-8") as fh:
                lines = fh.readlines()
            if len(lines) <= BASELINE_CAP:
                return
            with open(self.baseline_path, "w", encoding="utf-8") as fh:
                fh.writelines(lines[-BASELINE_CAP:])
        except OSError:
            pass

    def _read_config(self):
        try:
            with open(self.config_path, encoding="utf-8") as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return None
