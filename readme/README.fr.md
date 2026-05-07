[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [More languages](README.md)

# Rin

**Rin est un assistant IA personnel qui vit sur votre ordinateur, se souvient de ce qui compte et s'améliore avec l'usage quotidien.**

Ce n'est pas une simple fenêtre de chat de plus. Rin garde la même identité d'assistant entre les sessions, peut utiliser des outils locaux lorsque vous l'autorisez, et peut conserver l'expérience utile sous forme de mémoire ou de compétences réutilisables.

Rin est aussi construit avec Rin. Le projet utilise son propre assistant pour planifier, éditer, relire, traduire et maintenir le dépôt ; l'auto-amorçage fait donc partie du test produit, pas seulement du discours.

## Pourquoi essayer Rin

- **Démarrage rapide :** installez-le, lancez `rin`, puis parlez en langage naturel.
- **Arrêtez de vous répéter :** Rin peut mémoriser des faits durables, des préférences, des projets et des consignes récurrentes entre les conversations.
- **Faites accumuler l'expérience :** le travail répété peut devenir de la mémoire, des prompts et des compétences réutilisables sans que vous ayez à concevoir vous-même un système d'agents.
- **Gardez-le local et inspectable :** Rin s'exécute sur votre machine et expose les outils, fichiers et configurations qu'il utilise.
- **Un assistant, plusieurs accès :** le même assistant peut être utilisé depuis le terminal, la GUI, l'automatisation ou des applications de chat connectées.

## Ce que Rin peut aider à faire

Rin est un assistant généraliste. Selon votre configuration, il peut :

- résumer, réécrire et organiser des documents
- rechercher des informations récentes sur le web
- inspecter et gérer des fichiers
- créer des rappels et des tâches planifiées
- conserver des notes à long terme à partir de travaux répétés
- aider avec du code et des dépôts
- exécuter des commandes locales ou agir sur des services connectés sous votre supervision
- répondre depuis le terminal, l'application de bureau, des automatisations ou des chats connectés comme le même assistant

## Ce qui rend Rin différent

### Mémoire globale

Les sessions de chat ordinaires oublient trop de choses. Rin peut conserver des faits durables et des leçons réutilisables en dehors d'une seule conversation, puis les ramener lorsqu'ils sont utiles.

### Apprentissage automatique

Vous ne devriez pas avoir à devenir expert en prompts pour enseigner votre assistant. Rin peut transformer les corrections répétées et les workflows réussis en consignes et compétences compactes.

### Toujours actif en arrière-plan

Rin est conçu comme un assistant que l'on garde avec soi, pas comme un onglet jetable. Un processus en arrière-plan permet à plusieurs interfaces de se connecter au même état d'assistant.

### Rin aide à développer Rin

Rin est maintenu avec Rin. Ce dépôt est une démonstration vivante : l'assistant peut aider à améliorer l'assistant lui-même.

## État actuel

Rin est encore un logiciel jeune. Attendez-vous à des zones rugueuses, une documentation incomplète, des comportements instables et parfois des changements incompatibles.

Rin peut aussi consommer plus de tokens de modèle, de quota d'API ou de capacité d'abonnement qu'un chat ponctuel, car il peut garder du contexte, écrire de la mémoire, exécuter des tâches planifiées, chercher sur le web et appeler des modèles à répétition.

Gardez la supervision pour les actions importantes. Ne laissez pas Rin effectuer des actions irréversibles ou sensibles sauf si vous comprenez le risque et pouvez vérifier ou annuler le résultat.

## Installation

### Linux et macOS

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh
```

<details>
<summary>Autres canaux de publication</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --beta
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --nightly
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git main
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git deadbeef
```

</details>

### Windows

Installez depuis PowerShell ou Windows Terminal. Node.js et npm doivent d'abord être disponibles.

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1)))
```

<details>
<summary>Autres canaux de publication</summary>

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --beta
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --nightly
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git main
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git deadbeef
```

</details>

Sous Windows, l'installateur interactif ouvre par défaut l'installateur GUI. Après installation, `rin` ouvre par défaut la GUI de bureau, et Rin écrit aussi des lanceurs GUI ainsi qu'un lanceur de démarrage par utilisateur pour le runtime en arrière-plan.

### Dépôt déjà cloné

```bash
./install.sh              # stable release (default)
./install.sh --beta       # current weekly beta candidate
./install.sh --nightly    # current nightly build
./install.sh --git        # main
./install.sh --git main
./install.sh --git deadbeef
```

```powershell
.\install.ps1
.\install.ps1 --beta
.\install.ps1 --nightly
.\install.ps1 --git
.\install.ps1 --git main
.\install.ps1 --git deadbeef
```

## Commandes de base

```bash
rin            # ouvrir Rin
rin doctor     # inspecter l'état de santé et la configuration
rin status     # afficher l'activité des workers et des tâches planifiées
rin start      # démarrer le runtime en arrière-plan
rin stop       # arrêter le runtime en arrière-plan
rin restart    # redémarrer le runtime en arrière-plan
rin update     # mettre à jour le runtime Rin installé
rin -p "..."   # lancer un tour d'assistant non interactif
```

## Direction technique

Rin est construit sur Pi et conserve son esprit KISS :

- garder le cœur petit et compréhensible
- montrer au modèle les vrais outils et le vrai contexte
- laisser le modèle décider lorsque c'est la conception la plus simple et fiable
- éviter les astuces propres à un modèle et les prompts trop réglés
- préférer un état local transparent au verrouillage par une plateforme distante

Rin ne cherche pas à devenir un framework d'agents lourd. Il cherche à être un assistant quotidien pratique, capable de se souvenir, d'agir et de s'améliorer tout en restant inspectable.

## Mise à jour

Pour mettre à jour une installation normale de Rin, utilisez :

```bash
rin update              # stable release (default)
rin update --beta       # current weekly beta candidate
rin update --nightly    # current nightly build
rin update --git        # main
rin update --git main
rin update --git deadbeef
```

Stable est le choix par défaut pour l'installation et la mise à jour. `--beta` sélectionne le candidat beta hebdomadaire actuel, `--nightly` sélectionne la build nightly actuelle depuis `main`, et `--git` sans suffixe sélectionne `main`.

Évitez de traiter les workflows locaux du dépôt comme `git pull`, les reconstructions improvisées ou la relance de `install.sh` comme méthode par défaut pour mettre à jour une installation Rin existante.

## Documentation

Ce README est la vue d'ensemble publique pour les utilisateurs. Les traductions se trouvent dans `readme/README.*.md` et doivent rester alignées avec cette version anglaise.

Si vous modifiez Rin lui-même, commencez par [`docs/developer/README.md`](../docs/developer/README.md). Les guides runtime destinés aux agents et la documentation installée sont séparés de ce README public.
