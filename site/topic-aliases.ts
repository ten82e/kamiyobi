/* 主題のことばも、日本語で打つた人に屆ける。分野のラベル（`セキュリティ` 等）は画面に出るが、会議名その
 * 物に主題が英字で書かれた行が多い（`Applied Cryptography and Network Security`）。`暗号` と打つ人に
 * その行を渡すには、会議名に現れる英字を同じ検索語の組に入れるしかない（開催地と同じ方針 – **表示は
 * 変へん**）。**収録カタログの会議名に現れる語だけに限る**（現れん語は置いてない）。`視覚`→vision は
 * 語境界の照合（下の `foldedLetterAtWordBoundary`）を導入するまで別の語に誤爆して置けなかつた。
 * **新しい行を増やさん条目は置かない** – 追加 0 件の物（`機械学習`→machine learning
 * `データベース`→database `シンガポール`→singapore）は、分野ラベルや他の日本語名が既に同じ行を
 * 拾えていたので外した。 */
export const TOPIC_QUERY_ALIASES_JA: string[][] = [
  ["暗号", "crypto"],
  ["暗号理論", "crypto"],

  ["暗号論", "crypto"],
  ["量子コンピュータ", "quantum"],
  ["量子コンピューター", "quantum"],
  ["量子コンピューティング", "quantum"],
  ["量子計算", "quantum"],
  ["情報理論", "information theory"],

  ["エージェント", "agent"],
  ["アクセラレータ", "accelerator"],
  ["アクセラレーター", "accelerator"],
  ["ワイヤレス", "wireless"],
  ["知識表現", "knowledge representation"],
  /* `クラウドコンピューティング` は `cloud` に寄せる（25 行）。`クラウド` と打つと収録の分類語
   * （日本語で書かれている）に当たって 259 行になるので、長い表記のほうが少ない行になる –
   * 寄せの先を `くらうど`（件数欄に当たった語として載る形）にすれば 259 行に揃うが、件数欄は
   * 「英語で書かれた会議名（… など）も探しています」と言う文なので、日本語の語を載せられない
   * （実測で確かめた）。長い表記は 25 行に置くのが今の正。 */
  ["クラウドコンピューティング", "cloud"],
  /* `データセンター`→`data center` `ファイルシステム`→`file system` は置いていない –
   * 寄せは語のかたまりのまま照らすので、収録の書き方に連続した形が無く**追加 0 行**だった
   * （`data` と `center` を別々に含む行はあるが、それはこの語を打った人の探している行では
   * ない – 実測）。 */
  ["深層学習", "deep learning"],
  ["ディープラーニング", "deep learning"],
  ["画像", "image"],
  ["視覚", "vision"],
  ["音声", "speech"],
  ["無線", "wireless"],
  ["信号", "signal"],
  ["通信", "communication"],
  ["人間", "human"],
  ["ロボット", "robot"],
  ["ロボティクス", "robot"],
  ["センサー", "sensor"],
  ["統計", "statistics"],
  ["量子", "quantum"],
  ["ブロックチェーン", "blockchain"],
  ["信頼性", "reliability"],
  ["シミュレーション", "simulation"],
  ["最適化", "optimization"],
  ["検証", "verification"],
  ["教育", "education"],
  ["分散", "distributed"],
  ["分散処理", "distributed"],
  ["並列", "parallel"],
  ["並列処理", "parallel"],
  ["高性能計算", "high performance"],
  ["組み込み", "embedded"],
  ["組込み", "embedded"],
  ["形式手法", "formal method"],
  ["宇宙", "space"],
  /* 口の利かれる分野の語で、収録側の表記が英文字のものを足す（2026-09-23 実測:
   * 以下の日本語はいずれも 0 件で、同じ意味の英文字表記は数件〜数十件当たった。
   * 「収録に無い」と「打ち方が通じない」を区別できないと、そこで検索をやめる）。
   * 追加の基準は既存と同じく**収録カタログに英文字側が現れること**（死んだ寄せを
   * 作らない。`テスト`・`対話`・`モデリング` は当たり方が広すぎるので割愛した）。 */
  ["リアルタイム", "real-time"],
  ["実時間", "real-time"],
  ["スケジューリング", "scheduling"],
  ["プログラミング言語", "programming language"],
  ["コンパイラ", "compiler"],
  ["クラスタ", "cluster"],
  ["バイオインフォマティクス", "bioinformatics"],
  ["音響", "acoustic"],
  ["脆弱性", "vulnerability"],
  ["マルウェア", "malware"],

  ["侵入検知", "intrusion"],
  ["モバイル", "mobile"],
  ["ユーザインタフェース", "user interface"],
  ["ユーザインターフェース", "user interface"],
  ["ゲーム", "game"],
  ["エッジコンピューティング", "edge computing"],
  ["仮想現実", "virtual reality"],
  ["拡張現実", "augmented reality"],
  ["計算機アーキテクチャ", "computer architecture"],
  ["データ分析", "data analytics"],
  ["パターン認識", "pattern recognition"],
  /* 同じ調べものを続けて足した群（2026-09-23 実測: 日本語は 0 件も、英文字表記は
   * 1〜183 行当たっていた）。`自動運転` は入れていない（収録の英文字は `autonomous` で、
   * 自律システムまで入る。日本語の `自律` のほうを置いた）。 */
  ["プライバシー", "privacy"],
  ["医療", "medical"],
  ["医用", "medical"],
  ["健康", "health"],
  ["認知", "cognitive"],
  ["ドローン", "drone"],
  ["知識グラフ", "knowledge graph"],
  /* 分野の名前を、日本語で打つた人に屆ける（2026-10-17 實測: 収録の英文字表記は數〜
   * 數十行當たるのに、日本語は 0 件だつた – 「打ち方が通じない」と「収録に無い」を
   * 區別できないと、そこで檢索をやめる）。中黒の有無・長音の書き方も、同じ寄せ先へ
   * 束ねる（`kanaFold` は長音を落とすが、中黒は別の字なので兩方を持つ）。 */
  ["オペレーティングシステム", "operating systems"],
  ["オペレーティング・システム", "operating systems"],
  ["コンピュータグラフィックス", "graphics"],
  ["コンピューターグラフィックス", "graphics"],
  ["コンピュータ・グラフィックス", "graphics"],
  ["ソフトウェア工学", "software engineering"],
  ["ソフトウェア・エンジニアリング", "software engineering"],
  ["システムソフトウェア", "systems software"],
  ["サイバーセキュリティ", "cyber"],
  ["暗号技術", "cryptography"],
  ["アーキテクチャ", "architecture"],
  ["ハイパフォーマンスコンピューティング", "high performance"],
  ["ハイパフォーマンス・コンピューティング", "high performance"],
  ["データマイニング", "data mining"],
  ["推論", "reasoning"],
  ["プロトコル", "protocol"],
  ["センサネットワーク", "sensor network"],
  ["自律", "autonomous"],

  ["計算論言語学", "computational linguistics"],
  ["計算論的言語学", "computational linguistics"],
  ["計算言語学", "computational linguistics"],
  ["生体認証", "biometrics"],
  ["チャットボット", "chatbot"],
  ["ベンチマーク", "benchmark"],
  ["音楽情報", "music"],
  ["プライバシー保護", "privacy"],
  // `画像認識` は入れていない（英文字側が `image recognition` の語順で収録に現れない。
  // 当たった 3 行は `graphics, patterns and images` + 別箇所の `recognition` で、
  // 別表記として置く語ではない）。`画像`・`パターン認識`・`コンピュータビジョン` で引ける。

  ["延長", "extension"],

  ["検索技術", "retrieval"],
  ["設計自動化", "design automation"],
  ["計画立案", "planning"],
  ["自動計画", "planning"],
  ["プランニング", "planning"],
  ["ソフトウェアテスト", "software testing"],
  ["テスト", "testing"],
  ["プログラマブル", "programmable"],
  ["フィールドプログラマブル", "field-programmable"],
  ["再構成可能", "reconfigurable"],
  ["計算機支援協調", "cooperative work"],
  ["協調作業", "cooperative work"],
  ["ソーシャルコンピューティング", "social computing"],
  ["人間工学", "human factors"],
  ["アクセシビリティ", "accessibility"],
  ["自律エージェント", "autonomous agents"],
  ["自律移動", "autonomous"],

  ["人間コンピュータ相互作用", "human-computer interaction"],
  ["情報可視化", "visualization"],
  ["視覚化", "visualization"],
  ["セマンティックウェブ", "semantic web"],
  ["モバイルコンピューティング", "mobile computing"],
  ["デジタルフォレンジック", "digital forensics"],
  ["要求工学", "requirements"],
  ["バーチャルリアリティ", "virtual reality"],
  ["ソフトウェア品質", "software quality"],
  ["医用画像", "medical image"],
  ["インターネット測定", "internet measurement"],
  ["3次元", "3d"],
  ["並行処理", "concurrency"],
  ["地理情報", "geographic information"],
  ["量子情報", "quantum"],
  ["自然言語生成", "natural language generation"],
  ["ハードウェア", "hardware"],

  ["ワイヤレスネットワーク", "wireless networks"],
  ["ネットワーク測定", "network measurement"],
  ["ネットワーク計測", "network measurement"],
  ["ネットワーク管理", "network management"],
  ["性能評価", "performance evaluation"],

  ["データ管理", "data management"],
  ["データマネジメント", "data management"],

  ["分散ファイル", "file system"],
  ["分散ファイルシステム", "file system"],
  ["ヘテロジニアス計算", "heterogeneous computing"],
  ["ヘテロジニアスコンピューティング", "heterogeneous computing"],
  ["メタバース", "metaverse"],

  ["モノのインターネット", "IoT"],
  ["モノのインターネット", "internet of things"],
  ["ネットワークの測定", "network measurement"],
  ["インターネットの測定", "internet measurement"],
  ["データの管理", "data management"],
  ["プライバシーの保護", "privacy"],
  ["ものづくり", "manufacturing"],
];
