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
<html lang="hu">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SmartRelay — Jelzés a Gyergyó-Hargita régióból</title>
<meta name="description" content="A SmartRelay figyeli az időjárást és a karbantartási határidőket a Gyergyó-Hargita régióban, és szól, mielőtt gond lenne belőle.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Public+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/style.css">
</head>
<body>

<header class="site-header">
  <div class="wrap site-header__inner">
    <a href="/" class="logo">SmartRelay</a>
    <span class="logo-region">Gyergyó · Hargita</span>
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
        <p class="eyebrow">Élő jelzés — Gyergyó / Hargita</p>
        <h1>Jelek a hegyekből,<br>mielőtt szükséged<br>lenne rájuk.</h1>
        <p class="hero__sub">
          A SmartRelay figyeli az időjárást és a karbantartási határidőket
          a régióban, és csak akkor szól, ha tényleg számít.
        </p>
        <div class="hero__actions">
          <a class="btn btn--primary" href="<?= e($channelUrl) ?>">Csatlakozz a Telegram csatornához</a>
          <a class="btn btn--text" href="#funkciok">Mire való ez pontosan?</a>
        </div>
      </div>

      <div class="readout" role="group" aria-label="Élő időjárás adatok">
        <div class="readout__head">
          <span class="readout__location"><?= e($weather['location']) ?></span>
          <?php if ($weather['available']): ?>
            <span class="readout__updated">frissítve <?= e($weather['updated_at']) ?></span>
          <?php endif; ?>
        </div>

        <?php if ($weather['available']): ?>
          <div class="readout__grid">
            <div class="readout__item">
              <span class="readout__value"><?= e($weather['temperature']) ?></span>
              <span class="readout__label">hőmérséklet</span>
            </div>
            <div class="readout__item">
              <span class="readout__value"><?= e($weather['wind']) ?></span>
              <span class="readout__label">szél</span>
            </div>
            <div class="readout__item">
              <span class="readout__value"><?= e($weather['humidity']) ?></span>
              <span class="readout__label">páratartalom</span>
            </div>
            <div class="readout__item">
              <span class="readout__value"><?= e($weather['precipitation']) ?></span>
              <span class="readout__label">csapadék</span>
            </div>
          </div>
          <p class="readout__desc"><?= e($weather['description']) ?></p>
        <?php else: ?>
          <p class="readout__empty"><?= e($weather['description']) ?></p>
        <?php endif; ?>
      </div>
    </div>
  </section>

  <section id="funkciok" class="features">
    <div class="wrap">
      <div class="feature-grid">
        <article class="feature-card">
          <p class="eyebrow">Magánszemélyeknek</p>
          <h2>Tudd előre, mit hoz az idő</h2>
          <p>
            Fagy, hóvihar, erős szél — a SmartRelay figyeli a Gyergyó körüli
            időjárást, és azonnal szól, ha változik valami, amire reagálnod kell.
          </p>
        </article>
        <article class="feature-card">
          <p class="eyebrow">Kis üzemeknek</p>
          <h2>Ne maradjon el egy szervizdátum sem</h2>
          <p>
            A berendezéseid karbantartási határidőit a SmartRelay tartja számon,
            és emlékeztet, mielőtt lejárna valami.
          </p>
        </article>
      </div>
    </div>
  </section>

  <section class="how">
    <div class="wrap">
      <h2 class="how__title">Hogyan működik</h2>
      <ol class="how__steps">
        <li>
          <span class="how__num">1</span>
          <span class="how__text">Csatlakozol a Telegram csatornához</span>
        </li>
        <li>
          <span class="how__num">2</span>
          <span class="how__text">A SmartRelay minden reggel figyeli az adatokat</span>
        </li>
        <li>
          <span class="how__num">3</span>
          <span class="how__text">Csak akkor kapsz üzenetet, ha tényleg számít</span>
        </li>
      </ol>
    </div>
  </section>

</main>

<footer class="site-footer">
  <div class="wrap site-footer__inner">
    <p>SmartRelay — Gyergyócsomafalva, Harghita megye</p>
    <a href="<?= e($channelUrl) ?>">Telegram csatorna →</a>
  </div>
</footer>

</body>
</html>
