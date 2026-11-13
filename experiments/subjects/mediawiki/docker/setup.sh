#!/usr/bin/env bash
# Deploy MediaWiki 1.40.0 with the configuration of BEWT's mediawiki.Installer,
# using the CLI installer instead of the web wizard.
#   ./setup.sh          start (and install on first run)
#   ./setup.sh --reset  wipe the database and reinstall
set -euo pipefail
cd "$(dirname "$0")"
URL="${MW_URL:-http://localhost:8080}"
ADMIN_PASS='e2eW3Bt3s71nGB3nchM4rK'

if [[ "${1:-}" == "--reset" ]]; then docker compose down -v; fi
docker compose up -d
MW="docker compose exec -T mediawiki"

if $MW test -f /var/www/html/LocalSettings.php; then
  echo "already installed: $URL"; exit 0
fi

echo "waiting for the database..."
for i in $(seq 1 60); do
  if docker compose exec -T database mariadb -uwikiuser -pexample -e 'select 1' my_wiki >/dev/null 2>&1; then break; fi
  sleep 2
done

$MW php maintenance/install.php \
  --dbtype mysql --dbserver database --dbname my_wiki --dbuser wikiuser --dbpass example \
  --server "$URL" --scriptpath "" --lang en \
  --pass "$ADMIN_PASS" "E2E Web Testing wiki" admin

$MW bash -c 'cat >> /var/www/html/LocalSettings.php' <<'PHP'

# ---- BEWT installer choices -------------------------------------------------
$wgEnableEmail = false;
$wgEnableUserEmail = false;
$wgPingback = false;
$wgMainCacheType = CACHE_NONE;
$wgEmergencyContact = 'admin@wiki.example';
# User rights profile: "Authorized editors only" (fishbowl)
$wgGroupPermissions['*']['createaccount'] = false;
$wgGroupPermissions['*']['edit'] = false;
# Extensions ticked by mediawiki.Installer
foreach ( [ 'CiteThisPage', 'Echo', 'Interwiki', 'Linter', 'Nuke', 'ReplaceText',
            'WikiEditor', 'VisualEditor', 'CodeEditor' ] as $ext ) {
  wfLoadExtension( $ext );
}
# ---- MultilayerMT additions -------------------------------------------------
# Tests run in parallel and repeatedly against one instance: lift throttles
# that would otherwise make later runs fail for reasons unrelated to mutants.
$wgAccountCreationThrottle = [];
$wgPasswordAttemptThrottle = [];
$wgRateLimits = [];
$wgGroupPermissions['*']['noratelimit'] = true;
# Pages are viewed, changed and viewed again within one second; with HTTP
# revalidation (If-Modified-Since, 1 s resolution) the browser then shows the
# stale copy. BEWT's Selenium suite hides this with Thread.sleep() calls.
$wgCachePages = false;
# Rollback etc. finish page updates after the response is sent; a page viewed
# right afterwards can get the previous rendering from the parser cache.
$wgParserCacheType = CACHE_NONE;
PHP

$MW php maintenance/update.php --quick
# Admin needs a real name/e-mail to match the BEWT wizard.
$MW php maintenance/run.php resetUserEmail --no-reset-password admin admin@wiki.example 2>/dev/null || true
echo "installed: $URL (admin / $ADMIN_PASS)"
