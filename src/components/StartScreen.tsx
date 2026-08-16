interface StartScreenProps {
  musicEnabled: boolean;
  onToggleMusic: () => void;
  onEnter: () => void;
}

export function StartScreen({ musicEnabled, onToggleMusic, onEnter }: StartScreenProps) {
  return (
    <main className="screen start-screen">
      <div className="space-backdrop" aria-hidden="true">
        <i className="start-scene-glow" />
      </div>

      <header className="start-brand">
        <strong>跃动地平线</strong>
      </header>

      <section className="start-title">
        <h1><span>跃动</span><span>地平线</span></h1>
        <p><i aria-hidden="true" />跟随声音起飞</p>
      </section>

      <section className="start-actions" aria-label="开始游戏">
        <button className="shell-primary-button" type="button" onClick={onEnter}>
          进入游戏
        </button>
        <button
          className={`music-toggle ${musicEnabled ? 'is-enabled' : ''}`}
          type="button"
          aria-pressed={musicEnabled}
          onClick={onToggleMusic}
        >
          <span className="music-toggle-main">
            <span className="music-control-symbol" aria-hidden="true">♪</span>
            <strong>{musicEnabled ? '音乐已开启' : '打开音乐'}</strong>
            <span className="music-equalizer" aria-hidden="true">
              <i /><i /><i /><i /><i /><i />
            </span>
          </span>
          <span className="music-headphone-note">
            <i aria-hidden="true" />
            {musicEnabled ? '节拍已经准备好' : '推荐佩戴耳机体验'}
          </span>
        </button>
        <p className="visually-hidden" role="status">
          {musicEnabled
            ? '滑动避开地刺；同排方块任选一个即可接上连击。'
            : '请先打开音乐，完整感受节拍与轨道的呼吸。'}
        </p>
      </section>
    </main>
  );
}
