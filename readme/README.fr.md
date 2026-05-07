[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [More languages](README.md)

# Rin

> **Votre assistant IA personnel, vivant sur votre ordinateur.**<br>
> Rin se souvient de ce qui compte, aide sur de vraies tâches et s'améliore avec l'usage quotidien.

Ce n'est pas une simple fenêtre de chat de plus. Rin est un assistant que vous pouvez garder près de vous : local, inspectable, connecté à vos outils quand vous l'autorisez, et capable de transporter une mémoire utile entre les sessions.

> [!NOTE]
> Rin est aussi construit avec Rin. Le projet utilise son propre assistant pour planifier, éditer, relire, traduire et maintenir ce dépôt ; l'amélioration de soi est donc testée dans le produit lui-même.

## ✨ Pourquoi essayer Rin

| Vous voulez...                           | Rin est conçu pour...                                           |
| ---------------------------------------- | --------------------------------------------------------------- |
| répéter moins d'explications             | mémoriser faits, préférences, projets et consignes              |
| un assistant qui progresse avec le temps | transformer corrections et workflows réussis en mémoire         |
| quelque chose d'utile sans tout créer    | fournir mémoire, planification, outils, chat bridges et UI      |
| contrôler ce qu'il touche                | s'exécuter localement et montrer outils, fichiers et config     |
| un assistant accessible partout          | connecter terminal, application de bureau, automatisation, chat |

## 🧰 Ce que Rin peut aider à faire

Rin est un assistant généraliste. Selon votre configuration, il peut :

- résumer, réécrire et organiser des documents
- rechercher des informations récentes sur le web
- inspecter et gérer des fichiers
- créer des rappels et des tâches planifiées
- conserver des notes à long terme à partir de travaux répétés
- aider avec du code et des dépôts
- exécuter des commandes locales ou agir sur des services connectés sous votre supervision
- répondre depuis le terminal, l'application de bureau, des automatisations ou des chats connectés comme le même assistant

## 🌱 Ce qui rend Rin différent

### Mémoire globale

Les sessions de chat ordinaires oublient trop de choses. Rin peut conserver des faits durables et des leçons réutilisables en dehors d'une seule conversation, puis les ramener lorsqu'ils sont utiles.

### Apprentissage automatique

Vous ne devriez pas avoir à devenir expert en prompts pour enseigner votre assistant. Rin peut transformer les corrections répétées et les workflows réussis en consignes et compétences compactes.

### Toujours actif en arrière-plan

Rin est conçu comme un assistant que l'on garde avec soi, pas comme un onglet jetable. Un processus en arrière-plan permet à plusieurs interfaces de se connecter au même état d'assistant.

### Rin aide à développer Rin

Rin est maintenu avec Rin. Ce dépôt est une démonstration vivante : l'assistant peut aider à améliorer l'assistant lui-même.

## ⚠️ État actuel

> [!WARNING]
> Rin est encore jeune. Considérez l'usage quotidien comme expérimental : vous pouvez rencontrer des zones rugueuses, une documentation incomplète, des comportements instables ou parfois des changements incompatibles.

Rin peut aussi consommer plus de tokens de modèle, de quota d'API ou de capacité d'abonnement qu'un chat ponctuel, car il peut garder du contexte, écrire de la mémoire, exécuter des tâches planifiées, chercher sur le web et appeler des modèles à répétition.

Gardez la supervision pour les actions importantes. Ne laissez pas Rin effectuer des actions irréversibles ou sensibles sauf si vous comprenez le risque et pouvez vérifier ou annuler le résultat.

## 🚀 Installation

> [!TIP]
> La plupart des utilisateurs devraient commencer par la commande stable ci-dessous. Les canaux préversion et git sont dans les sections pliées.

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

## ⌨️ Commandes de base

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

<details>
<summary>🧭 Pour les lecteurs techniques</summary>

Rin est construit sur Pi et conserve son esprit KISS :

- garder le cœur petit et compréhensible
- montrer au modèle les vrais outils et le vrai contexte
- laisser le modèle décider lorsque c'est la conception la plus simple et fiable
- éviter les astuces propres à un modèle et les prompts trop réglés
- préférer un état local transparent au verrouillage par une plateforme distante

Rin ne cherche pas à devenir un framework d'agents lourd. Il cherche à être un assistant quotidien pratique, capable de se souvenir, d'agir et de s'améliorer tout en restant inspectable.

</details>

## 🔄 Mise à jour

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

## 📚 Documentation

Ce README est la vue d'ensemble publique pour les utilisateurs. Les traductions se trouvent dans `readme/README.*.md` et doivent rester alignées avec cette version anglaise.

Si vous modifiez Rin lui-même, commencez par [`docs/developer/README.md`](../docs/developer/README.md). Les guides runtime destinés aux agents et la documentation installée sont séparés de ce README public.
