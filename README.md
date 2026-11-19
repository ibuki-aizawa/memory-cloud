# memory-cloud

**AI エージェントに覚えておいてほしいことを、どの AI・どの PC からでも共有できる記憶サーバーです。**
Cloudflare の無料枠で動き、自分のアカウントにデプロイして使います。

## これは何？

AI エージェント（Claude Code、Codex、Cursor、claude.ai など）は、基本的に会話が終わると内容を忘れます。
ツールに記憶機能があっても、その記憶は**そのツールの中だけ**のものです。

- 新しい会話を始めるたびに「このプロジェクトでは SQLite を使っていて…」と説明し直す
- 前に AI と決めた方針や、ハマって解決した問題を、AI が覚えていない
- Claude Code に教えたことを、Cursor や Codex は知らない
- 別の AI エージェントや別のチャットに記憶が引き継がれない

memory-cloud を使うと、AI は必要なときに記憶サーバーへ問い合わせ、決まったことや教訓を書き込みます。
記憶はクラウドに 1 つだけあるので、**どの AI・どの PC から使っても同じ記憶**になります。

```
あなた: 認証まわりを直して
AI:     （記憶を検索）「認証は Bearer トークン方式。トークンは定数時間比較する」と
         決めてあるので、その方針で直します。
...
AI:     （記憶に追記）「ヘッダーの前後の空白で認証が失敗していた」
```

## 特長

- **AI をまたいで使える**: AI がツールを呼び出すための共通規格 [MCP](https://modelcontextprotocol.io/) に対応しています。
  Claude Code / Codex CLI / Gemini CLI / Cursor / VS Code（Copilot）/ Windsurf などから使えます
- **プロジェクトごとに分けられる**: 全プロジェクト共通の記憶と、プロジェクトごとの記憶を分けて持てます
- **誰が書いたかわかる**: AI ツールごとにトークンを分けるので、どの AI が書いた記憶かをサーバーが記録します。AI に好きな呼び名も付けられます
- **ブラウザで見られる**: AI どうしのやり取りやタスクの進み具合を、Web の管理画面（`/dashboard`）で見て、直せます（記憶の修正・削除、タスクの担当の変更など）
- **複数の AI で分担できる**: タスクボードと受信箱で、Claude Code と Codex などが同じプロジェクトの作業を取り合わずに分担し、引き継ぎやレビュー依頼ができます
- **AI の利用量を抑える作り**: 記憶を全部読み込むことはせず、必要なものだけを検索して読みます
- **無料で動く**: Cloudflare の無料プランの範囲で動きます。クレジットカードの登録も不要です
- **データは自分の手元**: 記憶は自分の Cloudflare アカウントに保存されます。第三者のサービスには預けません
- **導入スクリプト付き**: 各 AI ツールへの登録を、スクリプト 1 つで行えます

## 仕組み

```
 Claude Code ─┐
 Codex CLI  ──┤                  ┌──── Cloudflare（自分のアカウント）────┐
 Cursor     ──┼────── MCP ─────▶ │  記憶サーバー ──▶ 記憶のデータベース │
 VS Code    ──┘                  └──────────────────────────────────────┘
```

記憶サーバーは Cloudflare の **Workers**（自分のサーバーを持たずにプログラムを動かせるサービス）で動き、
記憶は **D1**（データベース）に保存されます。操作には Cloudflare のコマンド **wrangler** を使います。
無料プランで上限に達しても、その日のリクエストが失敗するだけで、勝手に課金されることはありません。

記憶の形（エンティティ・observation など）や AI に渡すルールは [docs/memory-model.md](docs/memory-model.md) で説明しています。AI は接続後に `whoami` を確認し、初回または更新案内があれば `guide` を読んでください。

---

## 使い始める

| 手順 | 回数 |
|---|---|
| [1. サーバーを用意する](#1-サーバーを用意する) | 全体で 1 回（20 分ほど） |
| [2. PC の AI ツールをつなぐ](#2-pc-の-ai-ツールをつなぐ) | PC ごとに 1 回 |
| [3. プロジェクトに導入する](#3-プロジェクトに導入する) | プロジェクトごとに 1 回 |

必要なもの:
- [Node.js](https://nodejs.org/) 20 以上
- [PowerShell 7](https://learn.microsoft.com/ja-jp/powershell/scripting/install/installing-powershell)（導入スクリプトに使います。macOS は `brew install powershell`）
- Claude Code、Codex CLI、Gemini CLI、Cursor、VS Code、Windsurf のどれか

コマンドは PowerShell と bash / zsh の両方で書いています。どちらでも同じものは 1 つにまとめています。

### 1. サーバーを用意する

**Cloudflare のアカウントを作る**: https://dash.cloudflare.com/sign-up でメールアドレスを登録します。
ドメインの追加を勧められても不要です（スキップしてください）。

**リポジトリを取得してログインする**（PowerShell / bash / zsh 共通）:

```sh
git clone https://github.com/ibuki-aizawa/memory-cloud.git
cd memory-cloud/memory-mcp-worker
npm install
npx wrangler login        # ブラウザが開くので「Allow」
```

**データベースを作る**（共通）:

```sh
npx wrangler d1 create memory-mcp
npx wrangler kv namespace create OAUTH_KV
```

それぞれの出力に表示される ID を、`wrangler.jsonc` の `database_id` と `id` に書き換えます
（リポジトリに入っている値は作者の環境のものです）。「設定ファイルに自動で追加するか」と聞かれたら **No** を選びます。

```sh
npm run db:init           # テーブルを作成
```

**デプロイする**（共通）:

```sh
npm run deploy
```

初回は URL の一部になる名前（サブドメイン）を決めるよう求められます。
最後に表示される `https://memory-mcp.<サブドメイン>.workers.dev` が、記憶サーバーの URL です。

**トークンを設定する**: トークンは、記憶サーバーに接続するためのパスワードです。ランダムな値を作ってサーバーに登録します。

PowerShell:

```powershell
$url = 'https://memory-mcp.<サブドメイン>.workers.dev'
$token = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
$token | npx wrangler secret put MEMORY_TOKEN
$token                    # 表示された値をパスワードマネージャーなどに保管
```

bash / zsh:

```sh
url='https://memory-mcp.<サブドメイン>.workers.dev'
token=$(openssl rand -hex 32)
printf '%s' "$token" | npx wrangler secret put MEMORY_TOKEN
echo "$token"             # 表示された値をパスワードマネージャーなどに保管
```

### 2. PC の AI ツールをつなぐ

リポジトリの直下（`memory-cloud/`）で実行します。この PC に入っている AI ツールを自動で探して設定します。

PowerShell:

```powershell
cd ..
pwsh ./client/setup-client.ps1 -Url $url -Token $token
```

bash / zsh:

```sh
cd ..
pwsh ./client/setup-client.ps1 -Url "$url" -Token "$token"

# 環境変数は ~/.memory-cloud.env に保存されるので、シェルの起動時に読み込むようにする（bash なら ~/.bashrc）
echo '[ -f ~/.memory-cloud.env ] && . ~/.memory-cloud.env' >> ~/.zshrc
```

AI ツールごとに専用のトークン（例: `claude-<PC 名>`）が発行され、どの AI が書いた記憶かを区別できるようになります。

終わったら、ターミナルとエディターを開き直してください。
Claude Code なら `/mcp` コマンドで `memory-global` が connected になっていれば成功です。
macOS で Cursor や VS Code が環境変数を読めない場合は、ターミナルから `cursor .` / `code .` で起動してください。

スクリプトが書き込むファイルや、手で設定する方法は [docs/clients.md](docs/clients.md) にあります。

### 3. プロジェクトに導入する

1. [`memory-kit/`](memory-kit/) の中身を、導入したいリポジトリにコピーします
   （必須は `AGENTS.md` と `scripts/`。あとは使うツールの分だけ。詳しくは [docs/clients.md](docs/clients.md)）
2. 導入先のリポジトリで、プロジェクトの略称（英小文字・数字・ハイフン）を決めて実行します（共通）

   ```sh
   pwsh ./scripts/init-project.ps1 -Slug myapp
   ```

3. コピーしたファイルを git にコミットします（トークンは含まれないので安全です）

ほかの PC やチームの人は、手順 2 を済ませていれば、clone するだけで同じ記憶を使えます。

---

## もっと知る

| ドキュメント | 内容 |
|---|---|
| [docs/memory-model.md](docs/memory-model.md) | 記憶の形、AI に渡すルール、ツールの一覧、server-memory からの移行 |
| [docs/clients.md](docs/clients.md) | AI ツールごとの設定ファイル、手で設定する方法 |
| [docs/agents.md](docs/agents.md) | エージェントの識別（AI ツールごとのトークン、書き手の記録） |
| [docs/coordination.md](docs/coordination.md) | 複数の AI での分担（タスクボード、受信箱、引き継ぎ） |
| [docs/dashboard.md](docs/dashboard.md) | Web の管理画面（タスク・メッセージ・記憶をブラウザで見て、直す） |
| [docs/operations.md](docs/operations.md) | 記憶の確認と修正、新しい版への更新、バックアップ、困ったとき、セキュリティ |

## ディレクトリ構成

```
memory-mcp-worker/   Cloudflare にデプロイする記憶サーバー本体
client/              PC ごとの接続スクリプト
memory-kit/          プロジェクトにコピーするテンプレート
docs/                詳しい説明
```
