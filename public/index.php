<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/vendor/autoload.php';

use SmartRelay\Services\LandingPageData;

$pageData   = new LandingPageData();
$weather    = $pageData->getWeatherSnapshot();
$channelUrl = $pageData->getChannelUrl();

function e(string $s): string
{
    return htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SmartRelay — Signals before you need them</title>
<meta name="description" content="SmartRelay watches the weather and maintenance schedules for your location, and speaks up only when it actually matters.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Public+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/style.css">
</head>
<body>

<header class="site-header">
  <div class="wrap site-header__inner">
    <a href="/" class="logo">SmartRelay</a>
    <span class="logo-region">Live signal relay</span>
  </div>
</header>

<main>

  <section class="hero">
    <div class="hero__ridge" aria-hidden="true">
      <svg viewBox="0 0 1200 260" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
        <polyline class="ridge-line"
          points="0,220 90,180 160,210 230,120 300,170 380,90 460,150 540,60 610,130 690,100 760,160 840,70 920,140 1000,110 1080,180 1160,150 1200,190"
          fill="none" />
        <circle class="pulse-node" cx="540" cy="60" r="5" />
        <circle class="pulse-ring pulse-ring--1" cx="540" cy="60" r="5" />
        <circle class="pulse-ring pulse-ring--2" cx="540" cy="60" r="5" />
      </svg>
    </div>

    <div class="wrap hero__inner">
      <div class="hero__text">
        <p class="eyebrow">Live signal — your location</p>
        <h1>Signals from the field,<br>before you<br>need them.</h1>
        <p class="hero__sub">
          SmartRelay watches the weather and maintenance schedules for your
          location, and only speaks up when it actually matters.
        </p>
        <div class="hero__actions">
          <a class="btn btn--primary" href="<?= e($channelUrl) ?>">Join the Telegram channel</a>
          <a class="btn btn--text" href="#features">What does this actually do?</a>
        </div>
      </div>

      <div class="readout" role="group" aria-label="Live weather data">
        <div class="readout__head">
          <span class="readout__location"><?= e($weather['location']) ?></span>
          <?php if ($weather['available']): ?>
            <span class="readout__updated">updated <?= e($weather['updated_at']) ?></span>
          <?php endif; ?>
        </div>

        <?php if ($weather['available']): ?>
          <div class="readout__grid">
            <div class="readout__item">
              <span class="readout__value"><?= e($weather['temperature']) ?></span>
              <span class="readout__label">temperature</span>
            </div>
            <div class="readout__item">
              <span class="readout__value"><?= e($weather['wind']) ?></span>
              <span class="readout__label">wind</span>
            </div>
            <div class="readout__item">
              <span class="readout__value"><?= e($weather['humidity']) ?></span>
              <span class="readout__label">humidity</span>
            </div>
            <div class="readout__item">
              <span class="readout__value"><?= e($weather['precipitation']) ?></span>
              <span class="readout__label">precipitation</span>
            </div>
          </div>
          <p class="readout__desc"><?= e($weather['description']) ?></p>
        <?php else: ?>
          <p class="readout__empty"><?= e($weather['description']) ?></p>
        <?php endif; ?>
      </div>
    </div>
  </section>

  <section id="features" class="features">
    <div class="wrap">
      <div class="feature-grid">
        <article class="feature-card">
          <p class="eyebrow">For individuals</p>
          <h2>Know what's coming, before it arrives</h2>
          <p>
            Frost, storms, high winds — SmartRelay watches local conditions
            and tells you right away when something changes that you need
            to react to.
          </p>
        </article>
        <article class="feature-card">
          <p class="eyebrow">For small operations</p>
          <h2>Never miss a service date again</h2>
          <p>
            SmartRelay tracks your equipment's maintenance schedule and
            reminds you before anything falls overdue.
          </p>
        </article>
      </div>
    </div>
  </section>

  <section class="how">
    <div class="wrap">
      <h2 class="how__title">How it works</h2>
      <ol class="how__steps">
        <li>
          <span class="how__num">1</span>
          <span class="how__text">You join the Telegram channel</span>
        </li>
        <li>
          <span class="how__num">2</span>
          <span class="how__text">SmartRelay checks the data every morning</span>
        </li>
        <li>
          <span class="how__num">3</span>
          <span class="how__text">You only get a message when it actually counts</span>
        </li>
      </ol>
    </div>
  </section>

</main>

<footer class="site-footer">
  <div class="wrap site-footer__inner">
    <p>SmartRelay — live signal relay platform</p>
    <a href="<?= e($channelUrl) ?>">Telegram channel →</a>
  </div>
</footer>

</body>
</html>
