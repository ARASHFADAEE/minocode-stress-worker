# minocode-stress-worker

ورکر تست فشار (k6) برای قابلیت «تست فشار سایت» مینوکد. این ورکر روی **GitHub Actions** اجرا می‌شود؛ سرور، کارت بانکی و هزینه نمی‌خواهد.

## چطور کار می‌کند

1. ورک‌فلو `.github/workflows/stress-worker.yml` هر ۶ ساعت (به وقت UTC در ساعت‌های ۰، ۶، ۱۲ و ۱۸) خودکار اجرا می‌شود. با دکمهٔ **Run workflow** هم می‌شود آن را دستی اجرا کرد.
2. هر اجرا روی یک رانر `ubuntu-latest` بالا می‌آید. رانرهای ریپوی عمومی ۴ هسته و ۱۶ گیگ رم دارند. اول k6 نصب می‌شود.
3. اسکریپت `worker/poller.sh` هر چند ثانیه (`POLL_INTERVAL`، پیش‌فرض ۵) به هاب درخواست می‌دهد:
   `GET {HUB_URL}/portal/stress/jobs/next` با هدر `X-AWC-Worker-Secret`.
4. اگر هاب کار جدیدی داشته باشد، ورکر آن را در یک فایل موقت می‌نویسد و `worker/checkout.js` را با k6 اجرا می‌کند. این اسکریپت مسیر محصول، سبد، صفحهٔ پرداخت و ثبت سفارش را با درگاه تستی طی می‌کند. در پایان، نتیجه به `callback_url` همان کار فرستاده می‌شود.
5. حدود ۵ ساعت و ۴۵ دقیقه بعد، poller تمیز خارج می‌شود و اجرای زمان‌بندی‌شدهٔ بعدی ادامه را به دست می‌گیرد. گیت‌هاب سقف ۶ ساعت برای هر job دارد. `concurrency` نمی‌گذارد دو ورکر هم‌زمان کار بردارند.

## راه‌اندازی (فقط یک بار)

1. در ریپو به **Settings ← Secrets and variables ← Actions ← New repository secret** بروید.
   - Name: `WORKER_SECRET`
   - Value: همان Worker Secret که در تنظیمات هاب مینوکد است.
2. (اختیاری) در تب **Variables** همان صفحه:
   - `HUB_URL`، پیش‌فرض `https://minocode.online/wp-json/awc/v1`
   - `POLL_INTERVAL` بر حسب ثانیه، پیش‌فرض `5`
3. به تب **Actions** بروید، ورک‌فلو «MinoCode k6 stress worker» را باز کنید و **Run workflow** را بزنید تا همین الان شروع کند.

تا وقتی `WORKER_SECRET` تنظیم نشده باشد، هر اجرا یک هشدار نشان می‌دهد و بدون خطا تمام می‌شود.

## دستورهای مفید

- **شروع دستی:** Actions ← Run workflow. با gh: `gh workflow run stress-worker.yml -R ARASHFADAEE/minocode-stress-worker`
- **توقف:** Cancel روی اجرای فعلی. برای توقف کامل: `gh workflow disable stress-worker.yml -R ARASHFADAEE/minocode-stress-worker`
- **دوباره روشن کردن:** `gh workflow enable stress-worker.yml -R ARASHFADAEE/minocode-stress-worker`
- **لاگ‌ها:** `gh run list -R ARASHFADAEE/minocode-stress-worker` و بعد `gh run view <id> --log`

## نکته‌ها

- **IP ثابت نیست.** رانرهای گیت‌هاب IP عوض می‌کنند. IP هر اجرا در مرحلهٔ «Show runner info» لاگ می‌شود. احراز ورکر فقط با secret انجام می‌شود، پس `awc_stress_worker_ips` را خالی بگذارید یا محدودیت IP را غیرفعال کنید.
- **امنیت:** secret فقط در Secrets گیت‌هاب ذخیره است و گیت‌هاب آن را در لاگ‌ها ماسک می‌کند. فایل کار و `summary.json` شامل توکن هستند، پس بعد از هر اجرا پاک می‌شوند و هیچ artifact عمومی ساخته نمی‌شود.
- **غیرفعال شدن خودکار:** گیت‌هاب ورک‌فلوهای زمان‌بندی‌شدهٔ ریپوی عمومی را بعد از ۶۰ روز بدون فعالیت غیرفعال می‌کند. هر چند وقت یک commit کوچک بزنید یا از تب Actions دوباره Enable کنید.
- **ریسک:** شرایط استفادهٔ گیت‌هاب اجرای بار سنگین نامرتبط با پروژهٔ ریپو را محدود می‌کند. برای بار خیلی سنگین یا استفادهٔ دائمی تجاری، یک VPS جداگانه مطمئن‌تر است.
