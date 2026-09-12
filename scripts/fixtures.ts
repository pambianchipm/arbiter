/** HTML fixtures for the smoke test — a real Tailwind page so the render path is exercised. */
export const HTML_V1 = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ember — coffee, delivered</title>
<script src="https://cdn.tailwindcss.com"></script>
<style>body{font-family:ui-sans-serif,system-ui,sans-serif}</style></head>
<body class="bg-stone-50 text-stone-900">
<header class="max-w-6xl mx-auto flex items-center justify-between px-6 py-5">
  <div class="text-xl font-bold tracking-tight">Ember</div>
  <nav class="hidden md:flex gap-8 text-sm text-stone-600"><a>Roasts</a><a>How it works</a><a>Pricing</a></nav>
  <a class="rounded-full bg-stone-900 text-white px-4 py-2 text-sm font-medium">Start my box</a>
</header>
<main class="max-w-6xl mx-auto px-6">
  <section class="grid md:grid-cols-2 gap-12 items-center py-20">
    <div>
      <p class="text-sm font-semibold text-amber-700 uppercase tracking-wider">Fresh-roasted weekly</p>
      <h1 class="mt-4 text-5xl font-extrabold leading-tight">Coffee that lands the week it's roasted.</h1>
      <p class="mt-6 text-lg text-stone-600">Two small-batch roasters a month, ground how you brew, on a schedule you control. Skip or cancel anytime.</p>
      <div class="mt-8 flex gap-3"><a class="rounded-full bg-amber-600 text-white px-6 py-3 font-semibold">Build my first box</a><a class="rounded-full border border-stone-300 px-6 py-3 font-semibold">See this month's roasts</a></div>
      <p class="mt-4 text-sm text-stone-500">From $18 per bag · free shipping over $30</p>
    </div>
    <div class="aspect-[4/5] rounded-3xl bg-gradient-to-br from-amber-200 via-orange-300 to-stone-800 shadow-2xl"></div>
  </section>
  <section class="grid md:grid-cols-3 gap-8 py-12 border-t border-stone-200">
    <div><h3 class="font-bold">Roasted to order</h3><p class="mt-2 text-stone-600">Your bag is roasted after you order, never before.</p></div>
    <div><h3 class="font-bold">Ground for your gear</h3><p class="mt-2 text-stone-600">Espresso, pour-over, French press or whole bean.</p></div>
    <div><h3 class="font-bold">Skip any week</h3><p class="mt-2 text-stone-600">Travelling? Pause from your phone in one tap.</p></div>
  </section>
</main>
<footer class="max-w-6xl mx-auto px-6 py-10 text-sm text-stone-500">© Ember Coffee Co.</footer>
</body></html>`;

export const HTML_V2A = HTML_V1.replace("py-20", "py-32").replace("gap-12", "gap-20");
export const HTML_V2B = HTML_V1.replace("py-20", "py-10").replace(
  '<section class="grid md:grid-cols-3',
  '<section class="py-6 text-center text-stone-600">★★★★★ 4.9 from 2,300 subscribers · “Best cup I’ve had at home.” — Maya R.</section>\n  <section class="grid md:grid-cols-3',
);
export const HTML_V3 = HTML_V2A;
