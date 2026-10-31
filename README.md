# Verity

Petite boule smiley 3D de bureau (Electron).

## Lancer
    npm install
    npm start

Copie `secrets.example.json` en `secrets.json` et remplis les clés (fichier ignoré par git), ou saisis-les dans Réglages.

## Publier une mise à jour
1. Change `version` dans `package.json` (ex. 1.2.0), commit, push.
2. `git tag v1.2.0 && git push origin v1.2.0`
3. GitHub Actions construit l'installeur Windows et le publie dans les Releases.
4. Les Verity installés le détectent (au démarrage puis toutes les 4 h), le téléchargent, vérifient sa somme SHA-256 et s'installent seuls.

Le dépôt doit être public pour que l'API des releases soit lisible sans jeton.
