import { useEffect, useRef, useState, type CSSProperties } from 'react';
import countdownTapUrl from '../assets/audio/ui-button-tap.mp3?base64';
import countdownOnUrl from '../assets/audio/ui-sound-on.mp3?base64';
import { AudioEngine } from '../audio/AudioEngine';
import {
  GameController,
  countChoiceRows,
  countMultiTargetRows,
  type GameHud,
} from '../game/GameController';
import { SCENE_COLOR_SCHEMES } from '../game/colorSchemes';
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
  const [countdown, setCountdown] = useState<number | null>(null);
  const [crashed, setCrashed] = useState(false);
  const total = countChoiceRows(level.events);
  const totalMultiTargetRows = countMultiTargetRows(level.events);
  const starProgress = getStarProgress({
    hits: hud.hits,
    total,
    doubleHitRows: hud.doubleHitRows,
    totalMultiTargetRows,
  }, hud.progress);
  const sceneColorId = controllerRef.current?.getColorSchemeId();
  const countdownColor = sceneColorId
    ? `#${SCENE_COLOR_SCHEMES[sceneColorId].primary.toString(16).padStart(6, '0')}`
    : '#4ddbff';
  useEffect(() => {
    if (!canvasRef.current || !stageRef.current) return;
    const controller = new GameController(canvasRef.current, level, {
      onHud: setHud,
      onCrash: () => {
        setCrashed(true);
        setCountdown(null);
        setPaused(false);
      },
      onDeath: (result) => {
        setCountdown(null);
        setPaused(false);
        onDeath(result);
      },
      onFinish,
    });
    controllerRef.current = controller;

    const resize = () => {
      const canvas = canvasRef.current;
      if (canvas) controller.resize(canvas.clientWidth, canvas.clientHeight);
    };
    controller.start();
    resize();
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('resize', resize);
      controller.destroy();
      controllerRef.current = null;
    };
  }, [level, onDeath, onFinish]);

  useEffect(() => {
    if (countdown === null) return;
    if (soundEnabled) AudioEngine.playEffect(countdown === 1 ? countdownOnUrl : countdownTapUrl);
    const timer = window.setTimeout(() => {
      if (countdown > 1) {
        setCountdown(countdown - 1);
        return;
      }
      void controllerRef.current?.togglePause().then((next) => {
        if (typeof next === 'boolean') setPaused(next);
        setCountdown(null);
      });
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [countdown, soundEnabled]);

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
    if (paused) {
      if (countdown === null) setCountdown(3);
      return;
    }
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
        <div className="game-star-progress">
          <StarRating
            label={t('game.starProgressLabel')}
            progress={starProgress}
          />
        </div>
        <button
          className="pause-button"
          type="button"
          aria-label={paused ? t('game.resume') : t('game.pause')}
          disabled={countdown !== null}
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
        <div className="route-progress-track">
          <span style={{ width: `${hud.progress * 100}%` }} />
        </div>
      </div>

      {paused && countdown === null && (
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

      {countdown !== null && (
        <div
          key={countdown}
          className="resume-countdown"
          role="timer"
          aria-live="assertive"
          aria-label={`${countdown}，${t('game.continue')}`}
          style={{ '--countdown-color': countdownColor } as CSSProperties}
        >
          {countdown}
        </div>
      )}

    </main>
  );
}
