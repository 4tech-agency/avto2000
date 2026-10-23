<?php
/**
 * Dump every CF7 form and every Elementor Pro form widget as JSON, so the
 * Cloudflare Worker can validate and mail submissions exactly as WordPress would.
 *
 *   wp --path=<wp_root> eval-file scripts/forms-dump.php
 *
 * Read-only. Prints JSON on stdout.
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }

$out = [ 'site' => [ 'title' => get_bloginfo( 'name' ), 'public' => (bool) get_option( 'blog_public' ) ], 'cf7' => [], 'elementor' => [] ];

/* ---------- Contact Form 7 ---------- */
if ( class_exists( 'WPCF7_ContactForm' ) ) {
	foreach ( WPCF7_ContactForm::find() as $form ) {
		$tags = [];
		foreach ( $form->scan_form_tags() as $t ) {
			if ( '' === $t->name ) { continue; }   // submit, etc.
			$tags[] = [
				'name'     => $t->name,
				'basetype' => $t->basetype,
				'required' => $t->is_required(),
				'values'   => array_values( $t->values ),
				'include_blank' => $t->has_option( 'include_blank' ),
			];
		}
		$messages = [];
		foreach ( (array) $form->prop( 'messages' ) as $k => $v ) { $messages[ $k ] = $v; }
		$out['cf7'][ (string) $form->id() ] = [
			'title'    => $form->title(),
			'tags'     => $tags,
			'messages' => $messages,
			'mail'     => $form->prop( 'mail' ),
		];
	}
}

/* ---------- Elementor Pro form widgets ---------- */
$walk = function ( $elements, $post_id ) use ( &$walk, &$out ) {
	foreach ( (array) $elements as $el ) {
		if ( 'widget' === ( $el['elType'] ?? '' ) && 'form' === ( $el['widgetType'] ?? '' ) ) {
			$s = $el['settings'];
			$fields = [];
			foreach ( (array) ( $s['form_fields'] ?? [] ) as $f ) {
				$fields[] = [
					'id'       => $f['custom_id'],
					'type'     => $f['field_type'] ?? 'text',
					'label'    => $f['field_label'] ?? $f['custom_id'],
					'required' => ! empty( $f['required'] ),
					'options'  => isset( $f['field_options'] ) ? preg_split( '/\R/', $f['field_options'] ) : [],
				];
			}
			$custom = ( 'yes' === ( $s['custom_messages'] ?? '' ) );
			$out['elementor'][ $el['id'] ] = [
				'post_id'  => $post_id,
				'name'     => $s['form_name'] ?? 'Form',
				'fields'   => $fields,
				'actions'  => array_values( (array) ( $s['submit_actions'] ?? [] ) ),
				'email'    => [
					'to'       => $s['email_to'] ?? get_option( 'admin_email' ),
					'subject'  => $s['email_subject'] ?? 'New message',
					'content'  => $s['email_content'] ?? '[all-fields]',
					'reply_to' => $s['email_reply_to'] ?? '',
					'from_name'=> $s['email_from_name'] ?? get_bloginfo( 'name' ),
				],
				/* Elementor's own defaults when custom messages are off */
				'messages' => [
					'success'  => $custom && ! empty( $s['success_message'] ) ? $s['success_message'] : 'Your submission was successful.',
					'error'    => $custom && ! empty( $s['error_message'] ) ? $s['error_message'] : 'Your submission failed because of an error.',
					'required' => $custom && ! empty( $s['required_field_message'] ) ? $s['required_field_message'] : 'This field is required.',
					'invalid'  => $custom && ! empty( $s['invalid_message'] ) ? $s['invalid_message'] : 'There’s something wrong. The form is invalid.',
				],
			];
		}
		if ( ! empty( $el['elements'] ) ) { $walk( $el['elements'], $post_id ); }
	}
};
$docs = get_posts( [ 'post_type' => [ 'page', 'post', 'elementor_library' ], 'post_status' => 'publish',
	'numberposts' => -1, 'meta_key' => '_elementor_data', 'fields' => 'ids' ] );
foreach ( $docs as $id ) {
	$walk( json_decode( get_post_meta( $id, '_elementor_data', true ), true ), $id );
}

echo wp_json_encode( $out, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES );
