[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [Plus de langues](README.md)

# Rin

Rin est un assistant IA que vous pouvez garder sur votre propre ordinateur.

Si vous utilisez déjà ChatGPT ou un abonnement OpenAI, Rin est l’étape suivante : un assistant qui mémorise les informations utiles d’une conversation à l’autre, apprend votre façon de travailler et vous aide sur de vraies tâches au lieu de repartir de zéro à chaque fois.

Rin n’est pas seulement une idée ou une démo. Ce dépôt est développé avec Rin lui-même : Rin sert d’assistant au long cours pour planifier, modifier, relire, traduire et maintenir Rin.

## Pourquoi Rin existe

La plupart des chats IA sont faciles à commencer et faciles à perdre.

Vous expliquez vos préférences, vos projets, vos outils et vos habitudes. Puis vous ouvrez un nouveau chat et vous recommencez. Rin essaie de rendre cette relation moins jetable.

Rin repose sur une promesse simple :

- garder le même assistant entre les sessions
- mémoriser globalement les faits utiles à long terme
- s’améliorer avec l’usage répété sans vous demander de maintenir des prompts parfaits
- se connecter aux fichiers locaux, aux informations web, aux calendriers et aux surfaces de chat
- rester assez compréhensible pour que vous puissiez l’inspecter et le contrôler

## Ce que vous pouvez faire avec Rin

Vous parlez à Rin en langage naturel. Rin peut ensuite utiliser les outils disponibles sur votre machine et dans vos comptes configurés.

Exemples :

- mémoriser préférences, noms, projets et instructions récurrentes
- résumer ou réécrire des documents
- inspecter et organiser des fichiers
- chercher des informations récentes sur le web
- créer des rappels et des tâches récurrentes
- garder des notes utiles issues du travail répété
- vous aider à opérer votre ordinateur ou vos services sous supervision
- répondre depuis un terminal, une GUI ou un chat connecté tout en restant le même assistant

Rin est conçu comme un assistant généraliste, pas seulement comme un outil de code. Le code et le travail sur dépôt ne sont qu’un type de tâche qu’il peut aider à faire.

## Ce qui rend Rin différent

### Prêt à l’emploi

Rin est livré comme un produit avec un seul point d’entrée : `rin`. Le but n’est pas de demander aux utilisateurs d’assembler eux-mêmes un framework, un système de mémoire, un planificateur et un pont de chat.

### Mémoire globale

Rin peut conserver des faits durables et de l’expérience réutilisable en dehors d’une conversation unique. Les nouvelles sessions peuvent démarrer avec davantage du contexte qui compte.

### Amélioration implicite

Rin peut transformer la pratique répétée en instructions et compétences réutilisables. Vous ne devriez pas devoir devenir ingénieur de prompts pour que votre assistant apprenne votre façon de travailler.

### Un assistant local au long cours

Rin possède un runtime en arrière-plan : l’assistant n’est donc pas attaché à une fenêtre jetable. Différentes interfaces peuvent accéder au même état sous-jacent.

### Développement auto-amorcé

Rin est maintenu avec Rin. Le projet est un test pratique de son propre design : l’assistant fourni par le produit sert aussi à construire, relire, traduire et améliorer le produit.

## La vision technique de Rin

Rin hérite des valeurs de conception de Pi :

- garder le système aussi simple que possible
- exposer clairement les outils et le contexte
- laisser le modèle décider quand il peut raisonnablement le faire
- éviter les workflows codés en dur qui ne servent qu’à compenser de mauvais prompts
- éviter de faire dépendre le produit d’astuces optimisées pour un seul modèle
- préférer un état local et inspectable au verrouillage par une plateforme distante

Pour les lecteurs techniques : Rin ne cherche pas à être une plateforme d’agents centrée sur une marketplace, ni un laboratoire d’auto-entraînement centré sur la recherche. C’est un produit d’assistant pratique qui garde un runtime réduit, donne au modèle des outils et une mémoire utiles, et se concentre sur l’utilité quotidienne à long terme.

## Démarrage rapide

### Linux et macOS

Installez avec une seule commande, sans cloner le dépôt :

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh
```

Autres canaux de publication :

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --beta
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --nightly
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git main
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git deadbeef
```

### Windows

Installez depuis PowerShell ou Windows Terminal avec Node.js et npm disponibles, sans cloner le dépôt :

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1)))
```

Autres canaux de publication :

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --beta
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --nightly
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git main
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git deadbeef
```

Sous Windows, l’installateur interactif ouvre la GUI par défaut. Il parcourt la langue, l’utilisateur cible, le répertoire d’installation, le fournisseur/modèle/authentification, la revue du plan et l’application finale. Si une écriture protégée doit être confirmée, la GUI affiche une commande de transfert d’une ligne pour le terminal au lieu de demander des identifiants privilégiés dans la fenêtre.

Après installation, Windows utilise une configuration orientée GUI : le lancement par défaut `rin` ouvre la GUI de bureau, et l’installateur écrit des lanceurs GUI directs ainsi qu’un lanceur de démarrage utilisateur pour le runtime en arrière-plan. Utilisez `rin gui` si vous voulez ouvrir la GUI depuis un terminal, ou `rin-install --tui` / `rin-install --no-gui` si vous avez besoin de l’installateur en terminal.

### Depuis un checkout existant

Si vous avez déjà le dépôt en local, les wrappers d’installation inclus suivent le même flux de sélection de version :

```bash
./install.sh              # stable release (par défaut)
./install.sh --beta       # candidat beta hebdomadaire actuel
./install.sh --nightly    # build nightly actuel
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

Ouvrez Rin :

```bash
rin
```

Vérifiez l’état si nécessaire :

```bash
rin doctor
rin status --watch  # activité live des workers et tâches planifiées
```

## État actuel, sécurité et coûts

Rin est développé activement et reste jeune. Attendez-vous à des angles rugueux, à des comportements instables, à de la documentation manquante et à quelques changements incompatibles.

Comme Rin peut conserver du contexte, écrire de la mémoire, exécuter du travail planifié, chercher sur le web et appeler des modèles à répétition, il peut consommer plus de tokens, de quota API ou de capacité d’abonnement qu’un chat ponctuel normal.

Supervisez les travaux importants. Ne laissez pas Rin effectuer des actions irréversibles, sensibles ou critiques en production sauf si vous comprenez le risque et pouvez vérifier ou annuler le résultat.

## Scénarios de déploiement

L’installateur reste un installateur local, mais ces formes de déploiement sont déjà praticables comme enveloppes autour des mêmes points d’entrée Linux/macOS/Windows. L’environnement cible doit toujours fournir les prérequis normaux de Rin, dont Node.js et npm :

| Scénario                                         | Faisabilité                                                | Notes                                                                                                                                                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installation locale ou pour un autre utilisateur | Déjà prise en charge                                       | L’installateur interactif peut cibler le compte actuel ou un autre utilisateur local, puis écrire les lanceurs et le service en arrière-plan de cet utilisateur.                                                                              |
| Installation par SSH                             | Déjà faisable                                              | Exécutez la commande bootstrap par SSH sur l’hôte distant. Un wrapper dédié `rin install --ssh` pourrait améliorer plus tard la détection et les messages d’erreur.                                                                           |
| Installation conteneurisée                       | Faisable avec une image Linux sans interface graphique     | Utilisez un volume persistant pour le home/répertoire d’installation de Rin et lancez le runtime en arrière-plan ou la CLI dans le conteneur. Les lanceurs GUI et les services utilisateur de l’hôte ne s’appliquent pas dans le conteneur.   |
| Installation en machine virtuelle                | Prise en charge via l’installateur normal de l’OS          | Installez Rin dans l’OS invité comme sur une machine physique. Les instantanés de VM facilitent le retour arrière, mais Rin ne gère que l’environnement invité.                                                                               |
| Installation sur NAS                             | Faisable si le NAS peut exécuter Node.js ou des conteneurs | Sur un NAS ouvert, privilégiez le chemin Linux normal ; sur un NAS de type appliance, privilégiez le modèle conteneur. Les gestionnaires de paquets du fournisseur et les shells restreints peuvent nécessiter des notes propres au matériel. |
| Installation dans le cloud                       | Prise en charge via SSH ou un bootstrap de type cloud-init | Traitez la VM cloud comme un hôte Linux distant. Conservez les données `.rin` sur un disque durable et configurez le démarrage en arrière-plan selon l’OS hôte.                                                                               |

Ce sont des scénarios de déploiement, pas des canaux de publication séparés. Stable, beta, nightly et git continuent d’utiliser le même contrat d’installation/mise à jour ci-dessus.

## Inclus aujourd’hui

Rin inclut une pile par défaut ciblée :

- mémoire à long terme
- tâches planifiées et rappels
- recherche web en direct
- outils de fichiers et de shell
- prise en charge du pont de chat
- accès GUI, TUI, CLI et de style RPC
- `rin -p` / `rin --mode json` non interactif pour des tours d’assistant délégués ou scriptables

## Mettre Rin à jour

Pour une mise à jour normale de Rin installé, utilisez :

```bash
rin update              # stable release (par défaut)
rin update --beta       # candidat beta hebdomadaire actuel
rin update --nightly    # build nightly actuel
rin update --git        # main
rin update --git main
rin update --git deadbeef
```

Si `rin` est confirmé absent du compte actuel, traitez cela comme « ce compte n’est pas l’utilisateur propriétaire du lanceur ». Retrouvez la vraie installation cible grâce aux métadonnées installées :

- `<targetHome>/.rin/installer.json`
- Linux : `~/.config/systemd/user/rin-daemon*.service`
- macOS : `~/Library/LaunchAgents/com.rin.daemon.*.plist`

Puis invoquez directement l’entrée stable du runtime installé :

```bash
node <installDir>/app/current/dist/app/rin/main.js update -u <targetUser>
```

C’est la voie canonique de mise à jour pour le runtime installé. Elle rafraîchit le runtime central et la documentation installée. Elle ne remplace pas le lanceur CLI utilisateur ni l’installateur.

Règles importantes des canaux de publication :

- stable est la valeur par défaut pour installer et mettre à jour
- `--beta` signifie le candidat beta hebdomadaire actuel
- `--nightly` signifie le build nightly actuel depuis `main`
- `--git` sans suffixe signifie `main`

Évitez de traiter les workflows locaux du dépôt comme `git pull`, les reconstructions ad hoc ou la relance de `install.sh` comme la méthode par défaut pour mettre à jour un Rin déjà installé.

## Commandes principales

```bash
rin            # ouvrir Rin
rin doctor     # inspecter l’état et la configuration
rin status     # afficher l’activité des workers et tâches planifiées
rin target     # lister et sélectionner les cibles de déploiement
rin --target x # lancer Rin sur un environnement cible configuré
rin start      # démarrer le runtime en arrière-plan
rin stop       # arrêter le runtime en arrière-plan
rin restart    # redémarrer le runtime en arrière-plan
rin update     # mettre à jour le runtime central installé de Rin
```

Normalement, utilisez `rin`. `rin --std` est une entrée de secours pour récupération au premier plan ou débogage lorsque le chemin RPC par défaut ne fonctionne pas.

## Documentation

Ce README est la documentation utilisateur. Les traductions se trouvent dans `readme/README.*.md` et doivent rester alignées avec la version anglaise ; mettez-les à jour dans le même changement lorsque le contenu visible par les utilisateurs change.

La documentation interne est volontairement séparée :

- Les instructions de runtime pour agents vivent dans `docs/agent/` et sont installées dans `agentDir/docs/rin/`.
- La documentation technique développeur vit dans `docs/developer/`.
- Les métadonnées de notes de version vivent dans `docs/release/CHANGELOG.md` pour `/changelog` et les workflows de publication.

Si vous modifiez Rin lui-même, commencez par [`docs/developer/README.md`](../docs/developer/README.md).

## État du projet

Rin évolue vers un cœur plus propre, une fiabilité plus forte, de meilleurs flux d’installation et de mise à jour, et une expérience d’assistant quotidien plus utile.

Il est encore tôt. Si vous voulez un produit fini et entièrement stabilisé, Rin n’en est pas encore là. Si vous voulez essayer un assistant IA local qui mémorise, s’améliore et sert déjà à se construire lui-même, c’est ce que Rin essaie de devenir.
