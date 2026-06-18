#!/bin/bash
# SmartRelay projekt feltöltő script
# Futtasd Git Bash-ban: bash setup.sh

set -e

echo "📁 Mappaszerkezet létrehozása..."
mkdir -p src/Core src/Collectors src/Processors src/Notifiers src/Services
mkdir -p tests/Unit/Core tests/Unit/Collectors tests/Unit/Notifiers tests/Unit/Services
mkdir -p tests/Integration
mkdir -p config public .github/workflows logs

echo "✅ Mappák kész"
echo ""
echo "📦 Git commit és push..."
git add -A
git status
git commit -m "feat: initial SmartRelay project structure

- Core interfaces (ServiceInterface, CollectorInterface, NotifierInterface)
- Config and Logger core classes
- AlertService and MaintenanceService orchestrators
- TelegramNotifier implementation
- Unit tests for Config, TelegramNotifier, AlertService
- PHPUnit setup (composer.json, phpunit.xml)
- Updated CLAUDE.md with peer review and testing rules
- Updated GitHub Actions workflow with test gate before deploy
- Equipment sample data (CMMS)"

git push origin main

echo ""
echo "🎉 Kész! A projekt fel van töltve GitHub-ra."
echo "   GitHub Actions → Run workflow → ellenőrizd a teszteket"
