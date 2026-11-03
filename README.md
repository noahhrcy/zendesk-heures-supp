# Heures supp Zendesk

Extension Chrome / Brave (Manifest V3) pour l'**espace agent Zendesk**.

Quand vous résolvez un ticket **en dehors de vos horaires** (par défaut 8h30–12h30 /
14h–17h, du lundi au vendredi, jours fériés exclus), une petite fenêtre demande si
vous avez fait des heures supp. La durée est préremplie avec le temps écoulé depuis
le **dernier appel noté dans le ticket**. L'extension tient le **solde** de vos
heures supp et prépare le **mail de déclaration** pour votre responsable.

## Installation

1. Télécharger le projet : bouton **Code → Download ZIP**, puis extraire l'archive.
2. Double-cliquer sur **`Installer.bat`**. L'extension est copiée dans
   `%LOCALAPPDATA%\HeuresSuppZendesk`, le chemin est mis dans le presse-papiers et
   la page des extensions du navigateur s'ouvre.
3. Dans cette page : activer le **Mode développeur**, cliquer **Charger l'extension
   non empaquetée**, coller le chemin (Ctrl+V) et valider.
4. Épingler l'icône (pièce de puzzle → punaise), puis ouvrir les **Réglages**
   (roue dentée) pour indiquer le destinataire du mail.

Les onglets Zendesk déjà ouverts sont pris en charge automatiquement.

## Utilisation

**Après une résolution hors horaires**, la fenêtre « Heures supplémentaires ? »
propose la durée (− / +, −15 min, +15 min, +30 min, +1 h) puis :

- **Oui, ajouter …** : les heures s'ajoutent au compteur « non déclarées » ;
- **Non, pas d'heures supp** : rien n'est compté ;
- **Plus tard** : la question suivante, ou la fenêtre se ferme (pastille orange sur l'icône) ;
- **Le ticket n'a pas été résolu** : la question est ignorée.

**L'icône** affiche le nombre de questions en attente (pastille orange), sinon les
heures non déclarées (pastille bleue). Sa fenêtre montre :

- **Non déclarées au chef** et **Solde d'heures supp** ;
- **Envoyer à …** : ouvre dans Outlook un mail prêt à partir (« Bonjour … »,
  tableau par numéro de ticket avec total, « Bonne journée »). Rien n'est envoyé
  automatiquement : vérifiez, envoyez, puis cliquez sur **C'est envoyé**. Le
  compteur « non déclarées » repart à zéro, le solde est conservé ;
- **+ Ajouter des heures** (saisie manuelle) et **− Utiliser des heures**
  (départ plus tôt, arrivée plus tard… : retiré du solde) ;
- l'historique récent (complet dans les Réglages, avec export Excel et sauvegarde).

## Comment la durée est proposée

- **Référence** : la note interne d'appel la plus récente, du type
  « Prénom NOM le 02/11/2026 14:31:41 appel vers … » (heure lue dans le texte), ou
  une note interne commençant par « appel » (heure de la note). Sans appel : la
  première ouverture du ticket.
- Seul le **temps hors horaires** est proposé (un appel à 16:50 résolu à 17:20
  propose 20 min), et une même plage n'est jamais proposée deux fois : après une
  résolution à 17:10, la suivante démarre à 17:10. L'écart complet reste proposé
  en un clic.

## Détection de la résolution

Sans aucun appel à l'API Zendesk : l'extension repère l'appui sur l'option
**Résolu** du menu d'envoi, sur le bouton **Envoyer comme Résolu** ou le
raccourci **Ctrl+Alt+S**, puis attend que Zendesk affiche le ticket **Résolu** (ou
ouvre le ticket créé, ou ferme l'onglet juste après l'envoi). Si l'envoi échoue
(champ obligatoire vide…) ou si un autre statut est choisi, rien ne se passe. Le
script **observe uniquement** : il ne clique sur rien et ne modifie rien dans Zendesk.

## Mises à jour

L'extension vérifie GitHub toutes les 6 heures et **vous prévient** (notification
et bandeau) quand une nouvelle version existe ; elle n'installe jamais rien seule.
Pour mettre à jour : double-cliquer sur **`Mettre-a-jour.bat`** dans le dossier de
l'extension. Elle se recharge d'elle-même dans les minutes qui suivent.

## Réglages locaux (facultatif)

Un fichier **`config.local.json`** placé dans le dossier de l'extension préremplit
les réglages du poste (il n'est jamais publié ni écrasé par les mises à jour).
Exemple : [`config.exemple.json`](config.exemple.json) — `recipientEmail`,
`recipientName`, `senderName`, `mailMethod` (`eml` ou `mailto`),
`testModeUntil` (mode test jusqu'à une date, heure locale).

## Mode test

Réglages → **Activer jusqu'à ce soir 23:59** : toute résolution compte comme hors
horaires et les lignes créées sont marquées **Test**. Elles ne partent jamais dans
le vrai mail (seules, elles donnent un mail « [TEST] ») et se suppriment en un clic.
**Aperçu de la fenêtre** la montre sans rien enregistrer.

## Données

Tout reste dans le navigateur (`chrome.storage.local`) : rien n'est envoyé ailleurs
que dans le brouillon de mail que vous ouvrez. Pensez à **Sauvegarder** de temps en
temps (Réglages) : désinstaller l'extension efface ses données.

## Limites connues

- Les résolutions **en masse** depuis une vue ne sont pas détectées : ajoutez-les
  avec « + Ajouter des heures ».
- Pour un ticket créé puis résolu en une fois avec fermeture de l'onglet, le
  numéro du ticket peut manquer (la ligne s'affiche « Nouveau ticket »).

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `manifest.json` | MV3 ; permissions `storage`, `alarms`, `notifications`, `downloads` (+ `downloads.open`), `scripting` ; accès à `*.zendesk.com` |
| `content.js` | Détection de la résolution et lecture du ticket (observation seule) |
| `background.js` | Seul à écrire les données ; décide si c'est hors horaires ; fenêtre ; badge ; vérification des mises à jour |
| `lib/core.js` | Logique pure : horaires, fériés, suggestion, totaux, mail `.eml` / mailto, CSV |
| `lib/ui.js`, `ui.css` | Outils et styles communs (animations comprises, désactivables dans les Réglages) |
| `prompt.*` | Fenêtre « Heures supplémentaires ? » |
| `popup.*` | Fenêtre de l'icône |
| `options.*` | Réglages, mode test, mises à jour, historique, export, sauvegarde |
| `Installer.bat`, `Mettre-a-jour.bat`, `outils/` | Installation, mise à jour manuelle, génération des icônes |
| `tests/` | Tests à ouvrir via un petit serveur local (`core.test.html`, `content.test.html`) |
