/**
 * Strings for the guided-repair dialog (plain-language column roles, set-aside
 * tables), the results trust signals (banner, research run, summary badge) and the
 * KPI scope line. Singular and plural forms are explicit keys (`_one` / `_many`)
 * so no text is built as "layer(s)". Merged into the dictionary in `localization.ts`.
 */
type Entry = { English: string; Mandarin: string; Japanese: string; Malay: string };

export const reviewTrustTranslations: Record<string, Entry> = {
    // --- Guided repair dialog: summary and disclosure ---
    review_summary_do: {
        English: 'Check where the data starts and ends and how each column is used, then press Confirm & Start Analysis.',
        Mandarin: '请确认数据从哪一行开始、到哪一行结束，以及每一列的用途，然后点击“确认并开始分析”。',
        Japanese: 'データの開始行と終了行、各列の使い方を確認してから、「確認して分析開始」を押してください。',
        Malay: 'Semak di mana data bermula dan berakhir serta cara setiap lajur digunakan, kemudian tekan "Sahkan dan mulakan analisis".',
    },
    review_more_details: {
        English: 'More about this check',
        Mandarin: '关于此检查的更多信息',
        Japanese: 'このチェックの詳細',
        Malay: 'Lagi tentang semakan ini',
    },
    review_other_reasons: {
        English: 'Other checks that need your review',
        Mandarin: '其他需要你确认的检查项',
        Japanese: 'ほかに確認が必要なチェック',
        Malay: 'Semakan lain yang memerlukan perhatian anda',
    },
    review_boundary_title: {
        English: 'Where the data starts and ends',
        Mandarin: '数据的起止位置',
        Japanese: 'データの開始位置と終了位置',
        Malay: 'Di mana data bermula dan berakhir',
    },
    review_scroll_more: {
        English: 'Scroll for more',
        Mandarin: '向下滚动查看更多',
        Japanese: 'スクロールして続きを表示',
        Malay: 'Tatal untuk lagi',
    },
    review_confirm_reassurance: {
        English: 'Your original file is not changed.',
        Mandarin: '你的原始文件不会被修改。',
        Japanese: '元のファイルは変更されません。',
        Malay: 'Fail asal anda tidak diubah.',
    },

    // --- Guided repair dialog: tiles ---
    review_header_layers_one: {
        English: '{count} layer',
        Mandarin: '{count} 层',
        Japanese: '{count} 層',
        Malay: '{count} lapisan',
    },
    review_header_layers_many: {
        English: '{count} layers',
        Mandarin: '{count} 层',
        Japanese: '{count} 層',
        Malay: '{count} lapisan',
    },
    review_set_aside_tile_one: {
        English: 'Other table set aside',
        Mandarin: '已搁置的其他表格',
        Japanese: '除外した他の表',
        Malay: 'Jadual lain diketepikan',
    },
    review_set_aside_tile_many: {
        English: 'Other tables set aside',
        Mandarin: '已搁置的其他表格',
        Japanese: '除外した他の表',
        Malay: 'Jadual lain diketepikan',
    },
    review_set_aside_rows_one: {
        English: '{rows} row',
        Mandarin: '{rows} 行',
        Japanese: '{rows} 行',
        Malay: '{rows} baris',
    },
    review_set_aside_rows_many: {
        English: '{rows} rows',
        Mandarin: '{rows} 行',
        Japanese: '{rows} 行',
        Malay: '{rows} baris',
    },
    review_list_and: {
        English: 'and',
        Mandarin: '和',
        Japanese: 'と',
        Malay: 'dan',
    },
    review_set_aside_stacked: {
        English: 'Your file has {count} tables stacked. Only the first is analysed.',
        Mandarin: '你的文件中叠放了 {count} 张表格，只分析第一张。',
        Japanese: 'ファイルには {count} 個の表が縦に並んでいます。分析するのは最初の表だけです。',
        Malay: 'Fail anda mempunyai {count} jadual yang bertindan. Hanya yang pertama dianalisis.',
    },

    // --- Guided repair dialog: column roles ---
    review_roles_title: {
        English: 'How should each column be used?',
        Mandarin: '每一列应该如何使用？',
        Japanese: '各列はどのように使いますか？',
        Malay: 'Bagaimana setiap lajur patut digunakan?',
    },
    review_roles_hint: {
        English: 'The app has already made a choice from each column\'s name and values. Change only what looks wrong, because a wrong choice can create misleading totals or groupings.',
        Mandarin: '系统已根据列名和内容为每一列做出选择。只需修改看起来不对的部分，因为错误的选择会导致误导性的合计或分组。',
        Japanese: 'アプリは列名と値から各列の使い方をすでに選んでいます。誤った選択は誤解を招く合計やグループ化につながるため、おかしいところだけ変更してください。',
        Malay: 'Aplikasi telah membuat pilihan berdasarkan nama dan nilai setiap lajur. Ubah hanya yang kelihatan salah, kerana pilihan yang salah boleh menghasilkan jumlah atau kumpulan yang mengelirukan.',
    },
    review_roles_example: {
        English: 'Example: Customer = group or label, Invoice Date = date, Amount = number to add up, Invoice No = ID.',
        Mandarin: '示例：客户 = 分组或标签，发票日期 = 日期，金额 = 需要求和的数字，发票号 = 编号。',
        Japanese: '例：顧客 = グループ・ラベル、請求日 = 日付、金額 = 合計する数値、請求書番号 = ID。',
        Malay: 'Contoh: Pelanggan = kumpulan atau label, Tarikh Invois = tarikh, Jumlah = nombor untuk dicampurkan, No Invois = ID.',
    },
    review_role_option_unspecified: {
        English: 'Not sure - let the app decide',
        Mandarin: '不确定 - 由系统决定',
        Japanese: '分からない - アプリに任せる',
        Malay: 'Tidak pasti - biar aplikasi tentukan',
    },
    review_role_option_dimension: {
        English: 'Group or label (customer, region, date)',
        Mandarin: '分组或标签（客户、地区、日期）',
        Japanese: 'グループ・ラベル（顧客、地域、日付）',
        Malay: 'Kumpulan atau label (pelanggan, wilayah, tarikh)',
    },
    review_role_option_metric: {
        English: 'Number to add up (amount, quantity)',
        Mandarin: '需要求和的数字（金额、数量）',
        Japanese: '合計する数値（金額、数量）',
        Malay: 'Nombor untuk dicampurkan (jumlah, kuantiti)',
    },
    review_role_option_identifier: {
        English: 'ID or code (never added up)',
        Mandarin: '编号或代码（不参与求和）',
        Japanese: 'IDまたはコード（合計しない）',
        Malay: 'ID atau kod (tidak pernah dicampurkan)',
    },
    review_role_option_helper: {
        English: 'Note or helper (ignored in analysis)',
        Mandarin: '备注或辅助列（分析时忽略）',
        Japanese: 'メモ・補助列（分析では無視）',
        Malay: 'Nota atau pembantu (diabaikan dalam analisis)',
    },
    review_role_suggested: {
        English: 'Suggested',
        Mandarin: '建议',
        Japanese: '推奨',
        Malay: 'Dicadangkan',
    },
    review_role_needs_choice: {
        English: 'Please choose',
        Mandarin: '请选择',
        Japanese: '選択してください',
        Malay: 'Sila pilih',
    },

    // --- Report context: set-aside tables stay visible after confirmation ---
    report_set_aside_note_one: {
        English: '{count} other table in the file was set aside ({rows})',
        Mandarin: '文件中另有 {count} 张表格已被搁置（{rows}）',
        Japanese: 'ファイル内の他の表 {count} 個を除外しました（{rows}）',
        Malay: '{count} jadual lain dalam fail telah diketepikan ({rows})',
    },
    report_set_aside_note_many: {
        English: '{count} other tables in the file were set aside ({rows})',
        Mandarin: '文件中另有 {count} 张表格已被搁置（{rows}）',
        Japanese: 'ファイル内の他の表 {count} 個を除外しました（{rows}）',
        Malay: '{count} jadual lain dalam fail telah diketepikan ({rows})',
    },

    // --- Results trust signals ---
    credibility_partial_title: {
        English: '{answered} of {total} questions answered',
        Mandarin: '{total} 个问题中已回答 {answered} 个',
        Japanese: '{total} 件の質問のうち {answered} 件に回答しました',
        Malay: '{answered} daripada {total} soalan telah dijawab',
    },
    credibility_partial_title_one: {
        English: '{answered} of {total} question answered',
        Mandarin: '{total} 个问题中已回答 {answered} 个',
        Japanese: '{total} 件の質問のうち {answered} 件に回答しました',
        Malay: '{answered} daripada {total} soalan telah dijawab',
    },
    credibility_partial_hint_one: {
        English: '{unsupported} could not be calculated from this data. The cards below passed their quality checks; the missing answer is not covered.',
        Mandarin: '有 {unsupported} 个无法用这份数据计算。下方的卡片已通过质量检查，缺少的答案不在其中。',
        Japanese: '{unsupported} 件はこのデータでは計算できませんでした。以下のカードは品質チェックを通過していますが、欠けている回答は含まれていません。',
        Malay: '{unsupported} tidak dapat dikira daripada data ini. Kad di bawah lulus semakan kualiti; jawapan yang tiada tidak dilindungi.',
    },
    credibility_partial_hint_many: {
        English: '{unsupported} could not be calculated from this data. The cards below passed their quality checks; the missing answers are not covered.',
        Mandarin: '有 {unsupported} 个无法用这份数据计算。下方的卡片已通过质量检查，缺少的答案不在其中。',
        Japanese: '{unsupported} 件はこのデータでは計算できませんでした。以下のカードは品質チェックを通過していますが、欠けている回答は含まれていません。',
        Malay: '{unsupported} tidak dapat dikira daripada data ini. Kad di bawah lulus semakan kualiti; jawapan yang tiada tidak dilindungi.',
    },
    credibility_unsupported_extra_one: {
        English: '1 question could not be calculated from this data.',
        Mandarin: '有 1 个问题无法用这份数据计算。',
        Japanese: '1 件の質問はこのデータでは計算できませんでした。',
        Malay: '1 soalan tidak dapat dikira daripada data ini.',
    },
    credibility_unsupported_extra_many: {
        English: '{count} questions could not be calculated from this data.',
        Mandarin: '有 {count} 个问题无法用这份数据计算。',
        Japanese: '{count} 件の質問はこのデータでは計算できませんでした。',
        Malay: '{count} soalan tidak dapat dikira daripada data ini.',
    },
    credibility_review_cards_button_one: {
        English: 'Review the card',
        Mandarin: '查看待复核卡片',
        Japanese: '要確認のカードを見る',
        Malay: 'Semak kad itu',
    },
    credibility_review_cards_button_many: {
        English: 'Review the {count} cards',
        Mandarin: '查看 {count} 张待复核卡片',
        Japanese: '要確認のカード {count} 枚を見る',
        Malay: 'Semak {count} kad',
    },
    credibility_show_all_cards: {
        English: 'Show all cards',
        Mandarin: '显示所有卡片',
        Japanese: 'すべてのカードを表示',
        Malay: 'Tunjukkan semua kad',
    },
    research_unanswered_count: {
        English: '{count} not answered',
        Mandarin: '{count} 项未回答',
        Japanese: '未回答 {count} 件',
        Malay: '{count} belum dijawab',
    },
    credibility_partial_caveats_suffix: {
        English: 'Data-quality limitations also remain; review the warnings.',
        Mandarin: '数据质量方面的限制仍然存在，请查看警告。',
        Japanese: 'データ品質上の制限も残っています。警告を確認してください。',
        Malay: 'Batasan kualiti data juga masih ada; semak amaran.',
    },
    research_not_supported_reason: {
        English: 'The data did not allow this calculation.',
        Mandarin: '这份数据无法完成此项计算。',
        Japanese: 'このデータではこの計算ができませんでした。',
        Malay: 'Data ini tidak membenarkan pengiraan ini.',
    },
    final_summary_badge_from_cards: {
        English: 'Built from the verified cards',
        Mandarin: '根据已验证的卡片生成',
        Japanese: '検証済みカードから作成',
        Malay: 'Dibina daripada kad yang disahkan',
    },

    // --- Executive KPI scope line: states its denominator ---
    executive_kpi_scope_coverage_top: {
        English: 'Top {shown} of {count} {groups}',
        Mandarin: '前 {shown} 个，共 {count} 个{groups}',
        Japanese: '{groups} {count} 件中の上位 {shown} 件',
        Malay: '{shown} teratas daripada {count} {groups}',
    },
    executive_kpi_scope_coverage_lowest: {
        English: 'Lowest {shown} of {count} {groups}',
        Mandarin: '最低 {shown} 个，共 {count} 个{groups}',
        Japanese: '{groups} {count} 件中の下位 {shown} 件',
        Malay: '{shown} terendah daripada {count} {groups}',
    },
    executive_kpi_scope_coverage_rows: {
        English: '{value} of {total} rows',
        Mandarin: '{total} 行中的 {value} 行',
        Japanese: '{total} 行中 {value} 行',
        Malay: '{value} daripada {total} baris',
    },
    executive_kpi_scope_coverage_value: {
        English: '{value} of {total}',
        Mandarin: '{total} 中的 {value}',
        Japanese: '{total} 中 {value}',
        Malay: '{value} daripada {total}',
    },
};
