[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [その他の言語](README.md)

# Rin

Rin は、自分のコンピューターに置いて使い続けられる AI アシスタントです。

すでに ChatGPT や OpenAI のサブスクリプションを使っていて、次の段階が欲しい人のために作られています。会話をまたいで役立つことを覚え、あなたの好みの進め方を学び、毎回ゼロから始めるのではなく実際の作業を手伝う、同じ一人のアシスタントです。

Rin は単なるアイデアやデモではありません。このリポジトリ自体が Rin によって開発されています。Rin は、計画、編集、レビュー、翻訳、保守を行う長期稼働のアシスタントとして使われています。

## Rin がある理由

多くの AI チャットは始めやすい一方で、文脈も簡単に失われます。

好み、プロジェクト、ツール、習慣を説明しても、新しいチャットを開くとまた説明し直すことになります。Rin は、その関係をもっと使い捨てではないものにしようとします。

Rin の約束はシンプルです。

- セッションをまたいで同じアシスタントを使い続ける
- 役立つ長期的な事実をグローバルに記憶する
- 完璧なプロンプトを手で保守しなくても、繰り返しの利用から改善する
- ローカルファイル、Web 情報、予定、チャット画面につながる
- あなたが確認し制御できる程度に分かりやすく保つ

## Rin でできること

Rin には普通の言葉で話しかけます。Rin は、あなたのマシンや設定済みアカウントで利用できるツールを使います。

例:

- 好み、名前、プロジェクト、繰り返し使う指示を覚える
- 文書を要約または書き直す
- ファイルを確認して整理する
- 最新情報を Web で検索する
- リマインダーや定期タスクを作成する
- 繰り返しの作業から役立つメモを残す
- 監督のもとでコンピューターやサービスの操作を手伝う
- ターミナル、GUI、接続済みチャット画面から、同じアシスタントとして応答する

Rin は汎用アシスタントを目指しており、コーディング専用ツールではありません。コードやリポジトリ作業は、手伝える作業の一部にすぎません。

## Rin の違い

### すぐ使える

Rin は `rin` という 1 つの入口を持つ製品としてパッケージされています。ユーザーにフレームワーク、記憶システム、スケジューラー、チャットブリッジを自分で組み合わせさせることが目的ではありません。

### グローバル記憶

Rin は、長期的な事実や再利用できる経験を単一の会話の外に保持できます。新しいセッションは、より重要な文脈を持った状態で始められます。

### 暗黙的な自己改善

Rin は、繰り返しの実践を再利用できる指示やスキルに変えられます。アシスタントに仕事の進め方を学ばせるために、ユーザーがプロンプトエンジニアになる必要はありません。

### 長期稼働するローカルアシスタント

Rin にはバックグラウンド実行環境があり、アシスタントは使い捨ての 1 つのウィンドウに縛られません。複数の入口から同じ基盤状態にアクセスできます。

### 自己ブートストラップされた開発

Rin は Rin によって保守されています。このプロジェクトは自身の設計の実践的なテストです。製品が提供するアシスタントは、製品自体の構築、レビュー、翻訳、改善にも使われています。

## 技術的な考え方

Rin は Pi らしい設計価値を受け継いでいます。

- システムをできるだけシンプルに保つ
- ツールと文脈を分かりやすく見せる
- モデルが妥当に判断できるところでは、判断をモデルに任せる
- 弱いプロンプトを補うためだけのハードコードされたワークフローを避ける
- 特定モデル向けの小技に製品を依存させない
- リモートプラットフォームへのロックインより、ローカルで確認可能な状態を優先する

技術者向けに言えば、Rin はマーケットプレイス優先の agent プラットフォームでも、研究優先の自己学習ラボでもありません。小さな実行環境、役立つツールと記憶、日常で長く使えることを重視する実用的なアシスタント製品です。

## クイックスタート

### Linux と macOS

リポジトリを clone せず、1 コマンドでインストールできます。

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh
```

その他のリリースチャネル:

```bash
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --beta
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --nightly
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git main
curl -fsSL https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.sh | sh -s -- --git deadbeef
```

### Windows

Node.js と npm が利用できる PowerShell または Windows Terminal から、clone なしでインストールできます。

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1)))
```

その他のリリースチャネル:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --beta
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --nightly
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git main
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchanai/rin/bootstrap/install.ps1))) --git deadbeef
```

Windows では、対話式インストーラーは既定で GUI インストーラーを開きます。言語、対象ユーザー、インストール先、プロバイダー/モデル/認証、計画確認、最終適用の順に案内します。保護された書き込みに確認が必要な場合、GUI は権限情報をウィンドウ内で求めず、1 行のターミナル引き継ぎコマンドを表示します。

インストール後の Windows は GUI 優先です。既定の `rin` はデスクトップ GUI を開き、インストーラーは直接 GUI ランチャーとユーザースコープのスタートアップランチャーを書き込みます。ターミナルから GUI を明示的に開くには `rin gui` を使います。ターミナルインストーラーが必要な場合は `rin-install --tui` / `rin-install --no-gui` を使います。

### 既存のチェックアウトから

すでにリポジトリが手元にある場合、同梱のインストールラッパーは同じリリース選択フローを使います。

```bash
./install.sh              # stable release（既定）
./install.sh --beta       # 現在の週次 beta 候補
./install.sh --nightly    # 現在の nightly ビルド
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

Rin を開く:

```bash
rin
```

必要なら状態を確認します。

```bash
rin doctor
rin status --watch  # live worker と定期タスクの動作
```

## 現在の状態、安全性、コスト

Rin は活発に開発中で、まだ初期段階です。粗い部分、不安定な動作、不足している文書、まれな破壊的変更を想定してください。

Rin は文脈を保持し、記憶を書き込み、定期処理を実行し、Web を検索し、モデルを繰り返し呼び出せるため、通常の一回きりのチャットより多くの token、API クォータ、サブスクリプション容量を使う場合があります。

重要な作業では監督してください。リスクを理解し、結果を確認またはロールバックできる場合を除き、不可逆・機密・本番重要な操作を Rin に任せないでください。

## デプロイシナリオ

インストーラーは現在もローカルインストーラーですが、次の形態は同じ Linux/macOS/Windows エントリーポイントの上に実現できます。対象環境には Node.js と npm を含む通常の Rin 前提条件が必要です。

| シナリオ                                 | 実現性                                                 | メモ                                                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ローカルまたは別ユーザーへのインストール | 現在サポート済み                                       | 対話式インストーラーで現在のアカウントまたは別のローカルユーザーを選び、そのユーザーのランチャーとバックグラウンドサービスを書き込みます。                                                 |
| SSH インストール                         | 現在でも実現可能                                       | リモートホスト上で SSH 経由で bootstrap コマンドを実行します。将来的には専用の `rin install --ssh` ラッパーで検出とエラー表示を改善できます。                                              |
| コンテナ化インストール                   | ヘッドレス Linux イメージなら実現可能                  | Rin home/インストールディレクトリを永続ボリュームに置き、コンテナ内でバックグラウンド実行環境または CLI を動かします。GUI ランチャーやホストのユーザーサービスはコンテナ内では対象外です。 |
| 仮想マシンへのインストール               | 通常の OS インストーラー経由でサポート                 | ゲスト OS 内で物理マシンと同じように Rin をインストールします。VM スナップショットはロールバックに役立ちますが、Rin が管理するのはゲスト環境だけです。                                     |
| NAS インストール                         | NAS が Node.js またはコンテナを実行できれば実現可能    | オープンな NAS では通常の Linux 手順を優先し、アプライアンス型 NAS ではコンテナ形態を優先します。ベンダー独自のパッケージ管理や制限付き shell には機種別の補足が必要になる場合があります。 |
| クラウドホストへのインストール           | SSH または cloud-init 形式のブートストラップでサポート | クラウド VM をリモート Linux ホストとして扱います。`.rin` データは永続ディスクに置き、バックグラウンド起動はホスト OS に合わせて設定します。                                               |

これらはデプロイシナリオであり、別のリリースチャネルではありません。stable、beta、nightly、git の選択は上記と同じインストール/更新契約を使い続けます。

## 現在組み込み済みのもの

Rin には、絞り込まれた既定スタックがあります。

- 長期記憶
- 定期タスクとリマインダー
- ライブ Web 検索
- ファイルと shell ツール
- チャットブリッジ対応
- GUI、TUI、CLI、RPC 風のアクセス経路
- 委任またはスクリプト化されたアシスタントターン用の非対話 `rin -p` / `rin --mode json`

## Rin の更新

通常のインストール済み Rin の更新には次を使います。

```bash
rin update              # stable release（既定）
rin update --beta       # 現在の週次 beta 候補
rin update --nightly    # 現在の nightly ビルド
rin update --git        # main
rin update --git main
rin update --git deadbeef
```

現在のアカウントで `rin` が見つからないことを確認した場合は、「このアカウントはランチャー所有ユーザーではない」と扱います。インストール済みメタデータから実際の対象インストールを復旧します。

- `<targetHome>/.rin/installer.json`
- Linux: `~/.config/systemd/user/rin-daemon*.service`
- macOS: `~/Library/LaunchAgents/com.rin.daemon.*.plist`

次に、安定したインストール済み実行環境の入口を直接呼び出します。

```bash
node <installDir>/app/current/dist/app/rin/main.js update -u <targetUser>
```

これはインストール済み実行環境の正規更新経路です。コア実行環境とインストール済み文書を更新します。ユーザースコープの CLI ランチャーやインストーラーは置き換えません。

重要なリリースチャネル規則:

- stable はインストールと更新の既定です
- `--beta` は現在の週次 beta 候補です
- `--nightly` は `main` からの現在の nightly ビルドです
- 接尾辞なしの `--git` は `main` を意味します

`git pull`、一時的な再ビルド、`install.sh` の再実行のようなリポジトリローカルの作業を、インストール済み Rin の既定更新方法として扱わないでください。

## コアコマンド

```bash
rin            # Rin を開く
rin doctor     # 状態と設定を確認する
rin status     # worker と定期タスクの動作を表示する
rin target     # デプロイ対象を一覧・選択する
rin --target x # 設定済み対象環境で Rin を実行する
rin start      # バックグラウンド実行環境を開始する
rin stop       # バックグラウンド実行環境を停止する
rin restart    # バックグラウンド実行環境を再起動する
rin update     # インストール済み Rin コアを更新する
```

通常は `rin` を使います。`rin --std` は、既定の RPC 経路が動かないときに前面で復旧またはデバッグするための予備入口です。

## ドキュメント

この README はユーザー向けドキュメントです。翻訳は `readme/README.*.md` にあり、英語版と同期している必要があります。ユーザー向け README を変更するときは、同じ変更で翻訳も更新してください。

内部ドキュメントは意図的に分けています。

- agent 向け実行環境ガイドは `docs/agent/` にあり、インストール後は `agentDir/docs/rin/` に入ります。
- 開発者向け技術文書は `docs/developer/` にあります。
- `/changelog` とリリースフロー用のリリースノートメタデータは `docs/release/CHANGELOG.md` にあります。

Rin 自体を変更する場合は、[`docs/developer/README.md`](../docs/developer/README.md) から始めてください。

## プロジェクトの状態

Rin は、よりきれいなコア、より強い信頼性、より良いインストール/更新フロー、そして日常でより役立つアシスタント体験に向かっています。

まだ初期段階です。完成済みで完全に安定した製品を求めるなら、Rin はまだそこにはありません。記憶し、改善し、すでに自身を作るためにも使われているローカル AI アシスタントを試したいなら、それが Rin の目指す姿です。
