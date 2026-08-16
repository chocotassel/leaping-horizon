interface StartScreenProps {
  musicEnabled: boolean;
  onToggleMusic: () => void;
  onEnter: () => void;
}

export function StartScreen({ musicEnabled, onToggleMusic, onEnter }: StartScreenProps) {
  return (
    <main className="screen start-screen">
      <div className="horizon-orbit" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>

      <header className="start-brand">
        <span>节奏飞行游戏</span>
        <small>RHYTHM HORIZON</small>
      </header>

      <section className="start-title">
        <p>跟随声音起飞</p>
        <h1>跃动<br /><strong>地平线</strong></h1>
        <span>让节拍铺成航线，让每一次滑动都落在音乐里。</span>
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
          <span className="music-toggle-copy">
            <strong>{musicEnabled ? '音乐已开启' : '打开音乐'}</strong>
            <small>{musicEnabled ? '节拍已经准备好' : '推荐佩戴耳机体验'}</small>
          </span>
          <span className="music-equalizer" aria-hidden="true"><i /><i /><i /></span>
        </button>
        <p className="music-guidance" role="status">
          {musicEnabled
            ? '进入游戏后，音乐会与轨道同步播放。'
            : '请先打开音乐，完整感受节拍与轨道的呼吸。'}
        </p>
      </section>
    </main>
  );
}
