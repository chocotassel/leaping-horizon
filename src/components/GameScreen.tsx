import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  GameController,
  countChoiceRows,
  countMultiTargetRows,
  type GameHud,
} from '../game/GameController';
import { getStarProgress } from '../game/stars';
import { formatNumber, t } from '../i18n';
import { type GameResult, type Level } from '../types';
import { StarRating } from './StarRating';

interface GameScreenProps {
  level: Level;
  soundEnabled: boolean;
  onDeath: (result: GameResult) => void;
  onExit: () => void;
  onFinish: (result: GameResult) => void;
  onToggleSound: () => void;
}

export function GameScreen({
  level,
  soundEnabled,
  onDeath,
  onExit,
  onFinish,
  onToggleSound,
}: GameScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<GameController | null>(null);
  const [hud, setHud] = useState<GameHud>({
    progress: 0,
    score: 0,
    hits: 0,
    doubleHitRows: 0,
  });
  const [paused, setPaused] = useState(false);
  const [crashed, setCrashed] = useState(false);
  const total = countChoiceRows(level.events);
  const totalMultiTargetRows = countMultiTargetRows(level.events);
  const starProgress = getStarProgress({
    hits: hud.hits,
    total,
    doubleHitRows: hud.doubleHitRows,
    totalMultiTargetRows,
  }, hud.progress);
  useEffect(() => {
    if (!canvasRef.current || !stageRef.current) return;
    const controller = new GameController(canvasRef.current, level, {
      onHud: setHud,
      onCrash: () => {
        setCrashed(true);
        setPaused(false);
      },
      onDeath: (result) => {
        setPaused(false);
        onDeath(result);
      },
      onFinish,
    });
    controllerRef.current = controller;

    const resize = () => {
      const rect = stageRef.current?.getBoundingClientRect();
      if (rect) controller.resize(rect.width, rect.height);
    };
    resize();
    window.addEventListener('resize', resize);
    controller.start();
    return () => {
      window.removeEventListener('resize', resize);
      controller.destroy();
      controllerRef.current = null;
    };
  }, [level, onDeath, onFinish]);

  const normalizePointer = (clientX: number) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    return ((clientX - rect.left) / rect.width) * 2 - 1;
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (paused) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    controllerRef.current?.setPointer(event.pointerId, normalizePointer(event.clientX));
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (paused || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    controllerRef.current?.setPointer(event.pointerId, normalizePointer(event.clientX));
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    controllerRef.current?.releasePointer(event.pointerId);
  };

  const stopGamePointer = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  };

  const togglePause = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const next = await controllerRef.current?.togglePause();
    if (typeof next === 'boolean') setPaused(next);
  };

  const togglePauseSound = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onToggleSound();
  };

  const exitGame = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onExit();
  };

  return (
    <main
      ref={stageRef}
      className={`screen game-screen${crashed ? ' is-crashed' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      <canvas ref={canvasRef} className="game-canvas" />
      <div className="game-vignette" />
      <div className="game-crash-atmosphere" aria-hidden="true" />
      <header className="game-hud">
        <div className="game-score">
          <span>{t('game.score')}</span>
          <strong>{formatNumber(hud.score)}</strong>
        </div>
        <div
          className="game-star-progress"
          style={{ '--star-rail-progress': hud.progress } as CSSProperties}
        >
          <StarRating
            label={t('game.starProgressLabel')}
            progress={starProgress}
          />
        </div>
        <button
          className="pause-button"
          type="button"
          aria-label={paused ? t('game.resume') : t('game.pause')}
          onPointerDown={stopGamePointer}
          onClick={togglePause}
        >
          {paused ? <span className="resume-icon">▶</span> : <><i /><i /></>}
        </button>
      </header>

      <div className="game-beat-wave" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /></div>

      <div
        className="route-progress"
        role="progressbar"
        aria-label={t('game.progress')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.floor(hud.progress * 100)}
      >
        <div className="route-progress-copy">
          <span>{t('game.progress')}</span>
          <strong>{Math.floor(hud.progress * 100)}%</strong>
        </div>
        <div className="route-progress-track">
          <span style={{ width: `${hud.progress * 100}%` }} />
          <i style={{ left: `${hud.progress * 100}%` }} />
        </div>
      </div>

      {paused && (
        <div className="pause-overlay">
          <div className="pause-orbit" aria-hidden="true"><i /><span>Ⅱ</span></div>
          <span>{t('game.paused')}</span>
          <strong>{t('game.pausedState')}</strong>
          <button
            className={`pause-music-toggle ${soundEnabled ? 'is-enabled' : ''}`}
            type="button"
            aria-pressed={soundEnabled}
            onPointerDown={stopGamePointer}
            onClick={togglePauseSound}
          >
            <span aria-hidden="true">♪</span>
            <strong>{t('game.music')}</strong>
            <small>{soundEnabled ? t('common.enabled') : t('common.disabled')}</small>
            <i aria-hidden="true" />
          </button>
          <div className="pause-actions">
            <button className="pause-primary-button" type="button" onPointerDown={stopGamePointer} onClick={togglePause}>
              {t('game.continue')}
            </button>
            <button className="pause-exit-button" type="button" onPointerDown={stopGamePointer} onClick={exitGame}>
              {t('game.exit')}
            </button>
          </div>
        </div>
      )}

    </main>
  );
}
