/**
 * Avto 2000 on Cloudflare.
 *
 * The site itself is static (public/, exported from WordPress). This Worker only
 * answers the two URLs the form scripts post to, with the same JSON WordPress
 * would return, so Contact Form 7's and Elementor Pro's own front-end code keeps
 * working unchanged:
 *
 *   POST /wp-json/contact-form-7/v1/contact-forms/:id/feedback   (CF7)
 *   GET  /wp-json/contact-form-7/v1/contact-forms/:id/feedback/schema
 *   POST /wp-admin/admin-ajax.php  action=elementor_pro_forms_send_form
 *
 * Form definitions (fields, required flags, messages, mail templates) come from
 * forms.generated.json, written by scripts/export.mjs from the WordPress install.
 *
 * Mail: MAIL_MODE = "log" only logs submissions (test mode, reports success);
 * "send" mails through the EMAIL binding (Cloudflare Email Routing) or Resend.
 */
import { EmailMessage } from 'cloudflare:email';
import FORMS from './forms.generated.json';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CF7_TEL_RE = /^[+]?[0-9() -]*[0-9][0-9() -]*$/;      // CF7's own: digits, spaces, ()+-
const ELEMENTOR_TEL_RE = /^[0-9()#&+*-=.]+$/;               // Elementor's pattern, verbatim

export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const path = url.pathname;
		let m;

		if ((m = path.match(/^\/wp-json\/contact-form-7\/v1\/contact-forms\/(\d+)\/feedback\/schema\/?$/))) {
			const form = FORMS.cf7[m[1]];
			return json(form?.schema ?? { code: 'wpcf7_not_found' }, form ? 200 : 404);
		}
		if ((m = path.match(/^\/wp-json\/contact-form-7\/v1\/contact-forms\/(\d+)\/refill\/?$/))) {
			return json({});
		}
		if ((m = path.match(/^\/wp-json\/contact-form-7\/v1\/contact-forms\/(\d+)\/feedback\/?$/)) && request.method === 'POST') {
			return cf7Submit(m[1], request, env, url);
		}
		if (path === '/wp-admin/admin-ajax.php' && request.method === 'POST') {
			return elementorSubmit(request, env, url);
		}

		/* anything else under /wp-json or /wp-admin does not exist on a static site */
		const notFound = await env.ASSETS.fetch(new Request(new URL('/404.html', url)));
		return new Response(notFound.body, { status: 404, headers: notFound.headers });
	},
};

/* ------------------------------------------------------------------ CF7 -- */
async function cf7Submit(id, request, env, url) {
	const form = FORMS.cf7[id];
	if (!form) {
		return json({ code: 'wpcf7_not_found', message: 'The requested contact form was not found.' }, 404);
	}
	const fd = await request.formData();
	const unit = fd.get('_wpcf7_unit_tag') || `wpcf7-f${id}-o1`;
	const msg = form.messages;

	const values = {};
	const invalid = [];
	for (const t of form.tags) {
		const all = fd.getAll(t.name).concat(fd.getAll(`${t.name}[]`));
		const v = all.map(String).join(', ').trim();
		values[t.name] = v;
		if (t.required && !v) { invalid.push([t.name, msg.invalid_required]); continue; }
		if (!v) continue;
		if (t.basetype === 'email' && !EMAIL_RE.test(v)) invalid.push([t.name, msg.invalid_email]);
		else if (t.basetype === 'tel' && !CF7_TEL_RE.test(v)) invalid.push([t.name, msg.invalid_tel]);
		else if (t.basetype === 'url' && !/^https?:\/\/\S+$/i.test(v)) invalid.push([t.name, msg.invalid_url]);
		else if (t.basetype === 'select' && t.values.length && !all.every((x) => t.values.includes(String(x)))) {
			invalid.push([t.name, msg.validation_error]);
		}
	}

	const base = { contact_form_id: Number(id), posted_data_hash: '', into: `#${unit}`, invalid_fields: [] };

	if (invalid.length) {
		return json({
			...base,
			status: 'validation_failed',
			message: msg.validation_error,
			invalid_fields: invalid.map(([field, message]) => ({
				field, message, idref: null, error_id: `${unit}-ve-${field}`,
			})),
		});
	}

	/* CF7 mail-tag replacement: [field] plus the special tags we can know */
	const special = {
		_site_title: FORMS.site.title,
		_site_url: url.origin,
		_url: request.headers.get('referer') || url.origin,
		_remote_ip: request.headers.get('cf-connecting-ip') || '',
		_user_agent: request.headers.get('user-agent') || '',
		_date: new Date().toISOString().slice(0, 10),
		_time: new Date().toISOString().slice(11, 16) + ' UTC',
	};
	const fill = (s = '') => s.replace(/\[([\w-]+)\]/g, (whole, name) =>
		name in values ? values[name] : name in special ? special[name] : whole);

	const mail = form.mail;
	const replyTo = /reply-to:\s*(.+)/i.exec(fill(mail.additional_headers || ''))?.[1]?.trim();
	const ok = await deliver(env, {
		form: `CF7 #${id} ${form.title}`,
		to: fill(mail.recipient),
		subject: fill(mail.subject),
		body: fill(mail.body),
		replyTo,
	});

	return json({
		...base,
		status: ok ? 'mail_sent' : 'mail_failed',
		message: ok ? msg.mail_sent_ok : msg.mail_sent_ng,
		posted_data_hash: await sha(JSON.stringify(values)),
	});
}

/* ------------------------------------------------------- Elementor Pro -- */
async function elementorSubmit(request, env, url) {
	const fd = await request.formData();
	if (fd.get('action') !== 'elementor_pro_forms_send_form') {
		return new Response('0', { status: 400 });   // what admin-ajax answers to unknown actions
	}
	const form = FORMS.elementor[fd.get('form_id')];
	if (!form) {
		return json({ success: false, data: { message: 'There’s something wrong. This form is invalid.', errors: [], data: [] } });
	}
	const values = {};
	const errors = {};
	for (const f of form.fields) {
		const all = fd.getAll(`form_fields[${f.id}]`).concat(fd.getAll(`form_fields[${f.id}][]`));
		const v = all.map(String).join(', ').trim();
		values[f.id] = v;
		if (f.required && !v) { errors[f.id] = form.messages.required; continue; }
		if (!v) continue;
		if (f.type === 'email' && !EMAIL_RE.test(v)) errors[f.id] = form.messages.invalid;
		if (f.type === 'tel' && !ELEMENTOR_TEL_RE.test(v)) errors[f.id] = form.messages.invalid;
	}
	if (Object.keys(errors).length) {
		return json({ success: false, data: { message: form.messages.invalid, errors, data: [] } });
	}

	let ok = true;
	if (form.actions.includes('email')) {
		const allFields = form.fields
			.filter((f) => values[f.id])
			.map((f) => `${f.label}: ${values[f.id]}`)
			.join('\n');
		const fill = (s = '') => s
			.replace(/\[all-fields\]/g, allFields)
			.replace(/\[field id=["']?([\w-]+)["']?\]/g, (_, id) => values[id] ?? '');
		ok = await deliver(env, {
			form: `Elementor ${form.name}`,
			to: form.email.to,
			subject: fill(form.email.subject),
			body: `${fill(form.email.content)}\n\n-- \nSent from ${url.origin} (${request.headers.get('referer') || ''})`,
			replyTo: form.email.reply_to ? values[form.email.reply_to] : undefined,
		});
	}

	return ok
		? json({ success: true, data: { message: form.messages.success, data: [] } })
		: json({ success: false, data: { message: form.messages.error, errors: [], data: [] } });
}

/* ------------------------------------------------------------- mail -- */
async function deliver(env, { form, to, subject, body, replyTo }) {
	const recipients = to.split(',').map((s) => s.trim()).filter(Boolean);
	/* always log: in test mode this IS the delivery, visible in Workers logs */
	console.log(JSON.stringify({ event: 'form_submission', form, to: recipients, subject, replyTo, body }));

	if ((env.MAIL_MODE || 'log') === 'log') return true;

	try {
		if (env.EMAIL && env.MAIL_FROM) {
			for (const rcpt of recipients) {
				const raw = mime({ from: env.MAIL_FROM, to: rcpt, subject, body, replyTo });
				await env.EMAIL.send(new EmailMessage(env.MAIL_FROM, rcpt, raw));
			}
			return true;
		}
		if (env.RESEND_API_KEY && env.MAIL_FROM) {
			const r = await fetch('https://api.resend.com/emails', {
				method: 'POST',
				headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ from: env.MAIL_FROM, to: recipients, subject, text: body, reply_to: replyTo }),
			});
			if (!r.ok) throw new Error(`Resend ${r.status}: ${await r.text()}`);
			return true;
		}
		throw new Error('MAIL_MODE=send but no EMAIL binding or RESEND_API_KEY + MAIL_FROM configured');
	} catch (e) {
		console.error(JSON.stringify({ event: 'mail_failed', form, error: String(e) }));
		return false;
	}
}

function mime({ from, to, subject, body, replyTo }) {
	const lines = [
		`From: ${from}`,
		`To: ${to}`,
		...(replyTo ? [`Reply-To: ${replyTo}`] : []),
		`Subject: =?UTF-8?B?${b64(subject)}?=`,
		`Date: ${new Date().toUTCString()}`,
		`Message-ID: <${crypto.randomUUID()}@${from.replace(/.*@|>.*/g, '')}>`,
		'MIME-Version: 1.0',
		'Content-Type: text/plain; charset=UTF-8',
		'Content-Transfer-Encoding: base64',
		'',
		b64(body).replace(/.{76}/g, '$&\r\n'),
	];
	return lines.join('\r\n');
}

/* -------------------------------------------------------------- utils -- */
function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' },
	});
}

function b64(s) {
	const bytes = new TextEncoder().encode(s);
	let bin = '';
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(bin);
}

async function sha(s) {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
	return [...new Uint8Array(d)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('');
}
