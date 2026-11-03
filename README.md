# 草相撲 - PeerJS / Vercel版

元の草相撲をベースに、オンライン対戦をPeerJS + WebRTCへ置き換えたVercel向けプロジェクトです。

## 機能

- CPU対戦
- 部屋コード対戦（同じコードを入力した2人を接続）
- ランダムマッチ（待機中のプレイヤーと自動でペアリング）
- オンライン人数の概算表示（直近75秒以内にアクセスしたセッション数）
- 対戦中の草データ・準備状態・連打数・勝敗をPeerJSのDataConnectionでP2P通信
- ログイン不要

## 構成

- `index.html`: ゲーム本体
- `api/match.js`: 待ち合わせ、部屋コード照合、オンライン人数のAPI
- PeerJS Cloud: PeerJSのシグナリング
- Upstash Redis: 待ち合わせ情報とオンライン状態の一時保存

ゲーム中の連打イベントをVercel API経由で中継する構成ではありません。Vercel/Redisは相手を見つけるために使い、相手が見つかった後はPeerJSのDataConnectionで直接通信します。

## デプロイ手順

### 1. Upstash Redisを作る

1. UpstashのコンソールでRedisデータベースを作成します。
2. Freeプランを選びます（無料プランはクレジットカード登録不要です）。
3. データベースの詳細画面からRESTの`UPSTASH_REDIS_REST_URL`と、書き込み可能なStandard Tokenを取得します。
4. Tokenは公開しないでください。HTMLやGitHubへ貼り付けず、Vercelの環境変数だけに登録します。

このプロジェクトはRedisのLua `EVAL`を使って、同時に参加したユーザーのマッチングを原子的に処理します。

### 2. GitHubへアップロード

このフォルダ内のファイルを、GitHubリポジトリのルートへアップロードします。`index.html`と`api`フォルダが同じ階層にある状態にしてください。

### 3. Vercelへデプロイ

1. VercelでGitHubリポジトリをImportします。
2. Framework Presetは`Other`（または自動検出）にします。Build CommandとOutput Directoryは空欄のままで構いません。
3. Project Settings → Environment Variablesで、次の2つを登録します。
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
4. ProductionだけでなくPreviewでもテストするなら、両方の環境に登録します。
5. Deployします。環境変数をあとから追加・変更した場合は再デプロイしてください。

### 4. 動作確認

1. デプロイしたURLを2つのブラウザ（または端末）で開きます。
2. 両方で草を描きます。
3. 部屋コード対戦なら、片方の表示コードをもう片方にも入力して対戦ボタンを押します。
4. ランダムマッチなら、両方で「ランダムマッチ」を押します。
5. 相手が接続されると「準備OK」が表示されます。両方が押すとカウントダウン後に対戦が始まります。

## ローカルで試す

Node.jsとVercel CLIを用意し、`.env.example`を参考に`.env.local`を作成してUpstashの値を設定します。

```bash
npx vercel dev
```

ブラウザで表示されたローカルURLを開きます。

## 注意点・制限

- PeerJS Cloudはシグナリングを担当します。実際のゲームデータはWebRTCで端末間を直接通信します。
- WebRTCはネットワーク環境によってP2P接続できないことがあります。学校・企業のネットワークや厳しいNAT環境では、TURNサーバーを別途用意しないと接続できない場合があります。このプロジェクトにはTURNサーバーを含めていません。
- オンライン人数はリアルタイムの厳密な同時接続数ではなく、直近75秒以内のハートビートを数えた概算です。ブラウザを閉じた直後などは最大75秒程度ずれることがあります。
- Peer-to-peer方式なので、対戦結果をサーバーで検証する仕組みやチート対策はありません。友人同士で遊ぶための試作向けです。
- PeerJS CloudおよびUpstash Freeの利用上限・提供状況は各サービス側の変更を受けます。
- オンラインAPIの環境変数が未設定でもCPU対戦は遊べます。オンライン対戦を押すと設定不足のエラーが表示されます。

## 外部ライブラリ

PeerJS 1.5.5をjsDelivr CDNから読み込んでいます。PeerJSの公式ドキュメントは https://peerjs.com/ です。
