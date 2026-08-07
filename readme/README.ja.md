[English](../README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md) · [Español](README.es.md) · [Français](README.fr.md) · [More languages](README.md)

# Rin

> **あなたのコンピューターに住む個人向け AI アシスタント。**<br>
> Rin は重要なことを覚え、実際の作業を手伝い、使うほど賢くなります。

Rin はローカルで動く汎用 AI アシスタントです。記憶、ツール、スケジュール、UI 入口、チャット連携を備えています。文書、Web 調査、ファイル、リマインダー、コード、接続サービス、繰り返し作業を支援し、ターミナル、デスクトップ、自動化、チャット入口で同じアシスタント状態を共有できます。

| 重要な点                       | Rin が提供するもの                                                     |
| ------------------------------ | ---------------------------------------------------------------------- |
| グローバルメモリ               | 有用な事実、好み、学びを単一のチャットの外に残せます。                 |
| 繰り返し利用から学習           | 修正や成功した手順を短い指示やスキルにできます。                       |
| ローカルのバックグラウンド動作 | 複数の入口が孤立したチャット窓ではなく、同じアシスタントに接続します。 |
| すぐ使える製品                 | 記憶、スケジュール、ツール、チャット連携、UI が含まれます。            |
| 自己ブートストラップ           | Rin は Rin の開発に使われ、このリポジトリ自体が実地テストです。        |

> [!WARNING]
> Rin はまだ若いソフトウェアです。日常利用でも実験的なものとして扱ってください。粗い部分、不足しているドキュメント、不安定な挙動、トークン/API コスト、破壊的変更に出会う可能性があります。

## Rin を支援する

Rin が時間の節約に役立ったなら、[Ko-fi](https://ko-fi.com/THE_cattail) で任意にメンテナンスを支援できます。スポンサーは継続的な保守費用を支えるもので、機能の優先順位や個別サポートを購入するものではありません。

## インストール

> [!TIP]
> 多くのユーザーは下の stable インストールコマンドから始めてください。これらのインストールコマンドをそのまま使えば、インストーラーが `rin` コマンドをセットアップします。プレリリースと git チャンネルは折りたたみ内にあります。

Rin はすべてのプラットフォームで Node.js 22.19.0 以降と npm を必要とします。

### Linux と macOS

```bash
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh
```

<details>
<summary>その他のリリースチャンネル</summary>

```bash
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --beta
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --nightly
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --git
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --git main
curl -fsSL https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.sh | sh -s -- --git deadbeef
```

</details>

### Windows

PowerShell または Windows Terminal からインストールします。

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1)))
```

<details>
<summary>その他のリリースチャンネル</summary>

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --beta
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --nightly
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --git
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --git main
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/rinchan-hoshino/rin/bootstrap/install.ps1))) --git deadbeef
```

</details>

インストール後は、すべてのプラットフォームで同じコマンドを使います:

```bash
rin
```

Windows インストーラーは `rin` コマンドランチャーを書き込み、可能な場合は Rin のユーザーランチャーディレクトリをユーザー `PATH` に追加します。現在のターミナルで `rin` がすぐ見つからない場合は、新しいターミナルを開いてください。

## 安全性とコスト

Rin はコンテキストを保持し、記憶を書き込み、スケジュール作業を実行し、Web 検索を行い、モデルを繰り返し呼び出せます。そのため、単発のチャットより多くのトークン、API クォータ、サブスクリプション容量を使う場合があります。

重要な操作では必ず監督してください。リスクを理解し、結果をレビューまたはロールバックできる場合を除き、不可逆または機密性の高い作業を Rin に任せないでください。

## 技術的な方向性

Rin は Pi の上に構築され、Pi の KISS 優先の精神を保っています。

- コアを小さく理解しやすく保つ
- 実際のツールとコンテキストをモデルに示す
- それが最も単純で信頼できる設計なら、モデルに判断させる
- モデル固有の小技や過度に調整されたプロンプトに依存しない
- リモートプラットフォームへのロックインより、透明なローカル状態を優先する

Rin は重い agent フレームワークを目指していません。記憶し、行動し、改善しながら、確認可能であり続ける実用的な日常アシスタントを目指しています。

## ドキュメント

この README は公開ユーザー向けの概要です。翻訳は `readme/README.*.md` にあり、英語版と揃えておく必要があります。

Rin 本体を変更する場合は、[`docs/developer/README.md`](../docs/developer/README.md) から始めてください。agent 向けランタイムガイドとインストール済みドキュメントは、この公開 README とは分けて管理されています。
