import json
import io
import zipfile
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import server

HTML = b'<table><tr><td>\xe9\xa2\x98\xe6\x9d\x90 / \xe6\x8c\x87\xe6\xa0\x87</td><td>A</td></tr><tr><td>2\xe6\x9d\xbf</td><td>One<br>Two</td></tr></table>'

class Tests(unittest.TestCase):
    def test_html_xls_preserves_line_breaks_and_date(self):
        result=server.parse_matrix('matrix_2026-11-13.xls',HTML)
        self.assertEqual(result['date'],'2026-11-13');self.assertEqual(len(result['stocks']),2)
        self.assertEqual(result['stocks'][0]['board'],2)

    def test_xlsx_matrix_import(self):
        data=io.BytesIO()
        with zipfile.ZipFile(data,'w') as z:
            z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="矩阵" sheetId="1" r:id="rId1"/></sheets></workbook>')
            z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
            z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>题材 / 指标</t></is></c><c r="B1" t="inlineStr"><is><t>芯片</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>2板</t></is></c><c r="B2" t="inlineStr"><is><t>甲股\n乙股</t></is></c></row></sheetData></worksheet>')
        parsed=server.parse_matrix('matrix_2026-11-13.xlsx',data.getvalue())
        self.assertEqual([s['name'] for s in parsed['stocks']],['甲股','乙股'])

    def test_missing_date_rejected(self):
        with self.assertRaises(ValueError):server.parse_matrix('matrix.xls',HTML)

    def test_fullwidth_and_space_name_matching(self):
        self.assertEqual(server.normalize_name('粤宏远Ａ'),'粤宏远A')
        self.assertEqual(server.normalize_name('达 意 隆'),'达意隆')

    def test_pagination_truncation_cannot_be_saved_as_complete(self):
        pages=[{'datas':[{'股票代码':'000001.SZ','股票简称':'甲'}],'code_count':2},{'datas':[],'code_count':2}]
        with patch.object(server,'request_wencai',side_effect=pages):
            with self.assertRaisesRegex(ValueError,'分页提前结束'):server.fetch_day('2026-11-13')

    def test_queue_accepts_new_imports_during_sync(self):
        old_job=server.JOB.copy();old_queue=server.QUEUE.copy()
        try:
            server.JOB.update(running=True,date='2026-11-13',total=1,scope='all',callType='normal')
            server.QUEUE[:]=[]
            with patch.dict(server.os.environ,{'IWENCAI_API_KEY':'test-key'}),patch.object(server,'load_state',return_value={'days':[{'date':'2026-11-13'},{'date':'2026-11-12'}]}):
                server.start_sync(['2026-11-13','2026-11-12'])
            self.assertEqual(server.QUEUE,['2026-11-12']);self.assertEqual(server.JOB['total'],2)
        finally:server.JOB.clear();server.JOB.update(old_job);server.QUEUE[:]=old_queue

    def test_sync_scope_and_retry_call_type_are_validated(self):
        old_job=server.JOB.copy();old_queue=server.QUEUE.copy()
        try:
            server.JOB.update(running=False,date=None,total=0,scope='all',callType='normal')
            with patch.dict(server.os.environ,{'IWENCAI_API_KEY':'test-key'}),patch.object(server,'load_state',return_value={'days':[{'date':'2026-11-13'}]}),patch.object(server.threading.Thread,'start'):
                server.start_sync(['2026-11-13'],scope='rebound',call_type='retry')
            self.assertEqual(server.QUEUE,['2026-11-13'])
            self.assertEqual(server.JOB['scope'],'rebound');self.assertEqual(server.JOB['callType'],'retry')
            server.JOB['running']=False
            with patch.dict(server.os.environ,{'IWENCAI_API_KEY':'test-key'}),patch.object(server,'load_state',return_value={'days':[{'date':'2026-11-13'}]}):
                with self.assertRaisesRegex(ValueError,'无效的数据补充范围'):server.start_sync(['2026-11-13'],scope='bad')
                with self.assertRaisesRegex(ValueError,'无效的问财调用类型'):server.start_sync(['2026-11-13'],call_type='bad')
        finally:server.JOB.clear();server.JOB.update(old_job);server.QUEUE[:]=old_queue

    def test_import_is_atomic(self):
        old=server.DATA
        with tempfile.TemporaryDirectory() as tmp:
            server.DATA=Path(tmp)
            try:
                with self.assertRaises(ValueError):server.import_days([('matrix_2026-11-13.xls',HTML),('bad.xls',b'bad')])
                self.assertEqual(server.load_state()['days'],[])
            finally:server.DATA=old

    def test_historical_metrics_never_use_current_value(self):
        rows=[{'股票简称':'甲','股票代码':'000001.SZ','最新价':999,'收盘价[20261112]':88,'最终涨停时间[20261113]':'2026-11-13 14:59:00','首次涨停时间[20261113]':'2026-11-13 09:30:00','封成比[20261113]':12.3}]
        result=server.normalize_rows(rows,'2026-11-13')['甲']
        self.assertIsNone(result['price']);self.assertEqual(result['lastLimit'],'14:59:00');self.assertEqual(result['sealRatio'],12.3)

    def test_epoch_limit_times_and_provider_seal_ratio_alias(self):
        rows=[{'股票简称':'甲','股票代码':'000001.SZ','首次涨停时间[20261113]':1794533400000,
               '最终涨停时间[20261113]':'1794553140000','涨停封单量占成交量比[20261113]':18.5}]
        result=server.normalize_rows(rows,'2026-11-13')['甲']
        self.assertEqual(result['firstLimit'],'09:30:00');self.assertEqual(result['lastLimit'],'14:59:00')
        self.assertEqual(result['sealRatio'],18.5)

    def test_province_query_and_normalization(self):
        self.assertTrue(server.query_text('2026-11-13').endswith('；省份'))
        rows=[{'股票简称':'甲','省份':'北京市'},{'股票简称':'乙','省份[20261113]':'浙江省'},{'股票简称':'丙','省份':'--'}]
        result=server.normalize_rows(rows,'2026-11-13')
        self.assertEqual(result['甲']['province'],'北京市');self.assertEqual(result['乙']['province'],'浙江省')
        self.assertIsNone(result['丙']['province'])

    def test_rebound_query_uses_trading_calendar_not_calendar_days(self):
        query, previous=server.rebound_query_text('2026-10-08')
        self.assertEqual(previous,['2026-09-29','2026-09-30'])
        self.assertEqual(query,'2026年10月8日主板非ST，2026年9月29日涨停，2026年9月30日非涨停，2026年10月8日涨停，股票简称，股票代码')

    def test_rebound_screen_is_persisted_and_filters_provider_drift(self):
        old=server.DATA
        with tempfile.TemporaryDirectory() as tmp:
            server.DATA=Path(tmp)
            try:
                server.import_days([('matrix_2026-11-13.xls',HTML)])
                rows=[{'股票代码':'600715.SH','股票简称':'文投控股','上市板块':'主板'},
                      {'股票代码':'300001.SZ','股票简称':'创业样本','上市板块':'创业板'},
                      {'股票代码':'600002.SH','股票简称':'ST样本','上市板块':'主板'}]
                with patch.object(server,'request_wencai',return_value={'datas':rows,'code_count':3}):
                    record=server.fetch_rebound_day('2026-11-13')
                self.assertEqual(record['count'],1);self.assertEqual(record['stocks'][0]['name'],'文投控股')
                saved=server.load_state()['days'][0]['rebound']
                self.assertEqual(saved['previousDates'],['2026-11-11','2026-11-12'])
                self.assertEqual(saved['source'],'同花顺问财')
            finally:server.DATA=old

    def test_reimport_retains_preferences_and_metrics(self):
        old=server.DATA
        with tempfile.TemporaryDirectory() as tmp:
            server.DATA=Path(tmp)
            try:
                server.import_days([('matrix_2026-11-13.xls',HTML)]);s=server.load_state()
                s['preferences']['days']=7;s['days'][0]['metrics']={'One':{'amount':123}};s['days'][0]['rebound']={'status':'ready','stocks':[{'name':'甲'}]};server.save_state(s)
                server.import_days([('matrix_2026-11-13.xls',HTML)])
                s=server.load_state();self.assertEqual(s['preferences']['days'],7);self.assertEqual(s['days'][0]['metrics']['One']['amount'],123)
                self.assertEqual(s['days'][0]['rebound']['stocks'][0]['name'],'甲')
            finally:server.DATA=old

    def test_supplied_excel_counts_are_complete(self):
        fixture_path=server.os.environ.get('REVIEW_BOARD_EXCEL_FIXTURES')
        if not fixture_path:self.skipTest('Local reference files unavailable')
        directory=Path(fixture_path)
        if not directory.exists():self.skipTest('Local reference files unavailable')
        files=list(directory.glob('*.xls'))
        self.assertGreaterEqual(len(files),10)
        for f in files:
            d=server.parse_matrix(f.name,f.read_bytes());self.assertTrue(d['complete'],f.name)
        d=server.parse_matrix('板块矩阵_2026-11-13.xls',(directory/'板块矩阵_2026-11-13.xls').read_bytes())
        self.assertEqual(len(d['stocks']),37)

if __name__=='__main__':unittest.main()
