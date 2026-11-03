# Changelog

All notable changes to Lockpick: Jail Bust HUD.

## 1.4.9
- **Refresh** is now a slim button between Best Bust and Best Bail, and updates the prisoner list in place instead of reloading the page. One press = one request for the jail list you're viewing; a second press within a second is ignored.
- Best Bust turns green when the best target is 80% or better; Best Bail turns green when someone is within your bail cap.
- Best Bust, Best Bail and Refresh only respond to real clicks and taps.
- Fixed: the heat badge next to Jail in Torn's menu could disappear after leaving the jail page until you switched tabs. It now comes back as soon as Torn redraws its menu.

## 1.4.8
- A saved API key stored as plain text (for example by TUCC, Torn Ultimate Command Centre) is now read correctly instead of being ignored.

## 1.4.7
- First public release on GitHub, with automatic updates through Tampermonkey.
- Best Bail turns red while nobody on the page fits your bail cap, and back to green when someone does.

## 1.4.6
- Bail prices are now exact: Torn charges every started minute, so the price is $100 × level × (shown minutes + 1), minus your discount. Best Bail, tooltips and the cap all use the charged price; "about" removed.

## 1.4.5
- Terms of service rebuilt so Torn's page styles can't affect it: readable light text, values aligned in their rows.

## 1.4.4
- Removed export/import. The Data tab now only holds "Erase all Lockpick data".

## 1.4.3
- Fixed: "Refresh level & perks now" could reset your heat to 0%. Level/perks and the bust log are now fetched separately, and a reply without a bust log never wipes heat.

## 1.4.2
- **PDA:** tap a prisoner's odds meter or the heat gauge to see its details (odds, difficulty, bail price, heat) in the HUD. Hover tooltips don't work on touch screens.
- **PDA:** larger buttons and switches on phone-sized screens; result messages wrap instead of being cut off.
- **PDA:** replaced CSS that older Android WebViews don't support.
- Accessible labels on the icon-only buttons (reload, settings, compact, full view, close).
- Terms of service now list bail pricing under purpose of use.
- Header credits and compliance notes brought up to date.

## 1.4.1
- Bail cap allows for Torn's rounded minutes, so a bail can never slip over your cap.
- With a cap set, a bail Lockpick can't price is blocked instead of allowed.
- Imported settings and history are type-checked.

## 1.4.0
- "Pick best" renamed **Best Bust**.
- New **Best Bail** button: one press clicks the cheapest bail on the page that's within your cap, showing its price.
- Separate on/off switches for each button (Settings → List).

## 1.3.0
- **Maximum bail** cap: bail clicks over your limit are blocked before anything is sent.
- Bail price shown for every prisoner. Your discount is learned from Torn's confirmation price, read from your perks, or set manually.

## 1.2.0
- New odds model based on difficulty = level × minutes left, Torn's own unit (bail = $100 × difficulty). Long sentences now show realistic odds.
- Odds can show the full range (under 1% to over 99%).
- Prisoners far harder than anything you've busted are marked as untested.
- Busting bonus override (%) replaces the old skill setting.
- Learning restarts under the new model; older results are kept but no longer used.

## 1.1.0
- The HUD, settings and result messages all sit inside the jail page, above the prisoner list. Nothing floats over the page or chat.
- Compact view: one slim strip.
- "Lockpick settings" in the Tampermonkey menu opens settings on the jail page from anywhere.

## 1.0.0
- First version: heat gauge, picks left, cool-down timer, odds meter on every prisoner, learning from your results, skip-confirm switches, settings tabs.
