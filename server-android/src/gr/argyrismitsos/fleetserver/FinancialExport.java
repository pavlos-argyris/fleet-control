package gr.argyrismitsos.fleetserver;

import org.json.*;
import java.io.*;
import java.math.BigDecimal;
import java.util.*;
import java.util.zip.*;
import com.tom_roush.pdfbox.pdmodel.*;
import com.tom_roush.pdfbox.pdmodel.common.PDRectangle;
import com.tom_roush.pdfbox.pdmodel.font.PDType0Font;

/** Both formats receive the same prepared, permission-checked financial table. */
public final class FinancialExport {
    private FinancialExport(){}
    private static String xml(Object value){return String.valueOf(value==null?"":value).replaceAll("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f]","").replace("&","&amp;").replace("<","&lt;").replace(">","&gt;").replace("\"","&quot;").replace("'","&apos;");}
    private static String column(int index){StringBuilder result=new StringBuilder();for(index++;index>0;index=(index-1)/26)result.insert(0,(char)('A'+(index-1)%26));return result.toString();}
    private static String display(Object value,String type)throws Exception{
        if(value==null||value==JSONObject.NULL)return "Άγνωστο";
        if("money".equals(type))return BigDecimal.valueOf(((Number)value).longValue()).movePointLeft(2).setScale(2).toPlainString().replace('.',',')+" €";
        return String.valueOf(value);
    }
    private static void validate(JSONObject spec)throws Exception{
        JSONArray tables=spec.getJSONArray("tables");if(tables.length()<1||tables.length()>8)throw new IOException("Μη έγκυρος αριθμός πινάκων εξαγωγής.");
        for(int t=0;t<tables.length();t++){
            JSONObject table=tables.getJSONObject(t);JSONArray columns=table.getJSONArray("columns"),rows=table.getJSONArray("rows");
            if(columns.length()<1||columns.length()>16||rows.length()>15000)throw new IOException("Διάλεξε μικρότερο διάστημα εξαγωγής.");
            for(int r=0;r<rows.length();r++){
                JSONArray row=rows.getJSONArray(r);if(row.length()!=columns.length())throw new IOException("Η εξαγωγή περιέχει ασύμβατη γραμμή.");
                for(int c=0;c<columns.length();c++){
                    Object v=row.get(c);String type=columns.getJSONObject(c).optString("type","text");
                    if(v!=JSONObject.NULL&&("money".equals(type)||"integer".equals(type))){if(!(v instanceof Number)||!Double.isFinite(((Number)v).doubleValue())||((Number)v).doubleValue()!=((Number)v).longValue()||Math.abs(((Number)v).doubleValue())>9007199254740991d)throw new IOException("Μη έγκυρος ακριβής αριθμός εξαγωγής.");}
                    if(String.valueOf(v).length()>32700)throw new IOException("Το κείμενο μιας εγγραφής υπερβαίνει το όριο Excel.");
                }
            }
        }
    }
    private static void zip(ZipOutputStream output,String name,String text)throws Exception{ZipEntry entry=new ZipEntry(name);entry.setTime(0);output.putNextEntry(entry);output.write(text.getBytes("UTF-8"));output.closeEntry();}
    public static void writeXlsx(File target,JSONObject spec)throws Exception{
        validate(spec);JSONArray tables=spec.getJSONArray("tables");
        try(ZipOutputStream output=new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(target)))){
            StringBuilder types=new StringBuilder("<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/>");
            StringBuilder workbook=new StringBuilder("<?xml version=\"1.0\"?><workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets>"),relations=new StringBuilder("<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">");
            for(int t=0;t<tables.length();t++){
                JSONObject table=tables.getJSONObject(t);JSONArray columns=table.getJSONArray("columns"),rows=table.getJSONArray("rows");String name=table.getString("name");if(name.length()>31||name.matches(".*[\\\\/:?*\\[\\]].*"))throw new IOException("Μη έγκυρο όνομα φύλλου Excel.");
                workbook.append("<sheet name=\"").append(xml(name)).append("\" sheetId=\"").append(t+1).append("\" r:id=\"rId").append(t+1).append("\"/>");
                types.append("<Override PartName=\"/xl/worksheets/sheet").append(t+1).append(".xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>");
                relations.append("<Relationship Id=\"rId").append(t+1).append("\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet").append(t+1).append(".xml\"/>");
                StringBuilder sheet=new StringBuilder("<?xml version=\"1.0\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetViews><sheetView workbookViewId=\"0\"><pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/></sheetView></sheetViews><cols>");
                for(int c=0;c<columns.length();c++)sheet.append("<col min=\"").append(c+1).append("\" max=\"").append(c+1).append("\" width=\"").append(columns.getJSONObject(c).optInt("width",100)/6.0).append("\" customWidth=\"1\"/>");
                sheet.append("</cols><sheetData>");
                for(int r=-1;r<rows.length();r++){
                    sheet.append("<row r=\"").append(r+2).append("\">");
                    for(int c=0;c<columns.length();c++){
                        JSONObject col=columns.getJSONObject(c);Object value=r<0?col.getString("label"):rows.getJSONArray(r).get(c);String type=col.optString("type","text"),ref=column(c)+(r+2);
                        if(r>=0&&value!=JSONObject.NULL&&("money".equals(type)||"integer".equals(type))){String number="money".equals(type)?BigDecimal.valueOf(((Number)value).longValue()).movePointLeft(2).toPlainString():String.valueOf(((Number)value).longValue());sheet.append("<c r=\"").append(ref).append("\" s=\"").append("money".equals(type)?2:0).append("\"><v>").append(number).append("</v></c>");}
                        else sheet.append("<c r=\"").append(ref).append("\" t=\"inlineStr\" s=\"").append(r<0?1:0).append("\"><is><t xml:space=\"preserve\">").append(xml(value==JSONObject.NULL?"Άγνωστο":value)).append("</t></is></c>");
                    }
                    sheet.append("</row>");
                }
                sheet.append("</sheetData><autoFilter ref=\"A1:").append(column(columns.length()-1)).append(Math.max(1,rows.length()+1)).append("\"/><pageMargins left=\"0.3\" right=\"0.3\" top=\"0.4\" bottom=\"0.4\" header=\"0.2\" footer=\"0.2\"/><pageSetup orientation=\"landscape\" fitToWidth=\"1\" fitToHeight=\"0\"/></worksheet>");
                zip(output,"xl/worksheets/sheet"+(t+1)+".xml",sheet.toString());
            }
            zip(output,"[Content_Types].xml",types.append("</Types>").toString());zip(output,"xl/workbook.xml",workbook.append("</sheets></workbook>").toString());
            zip(output,"xl/_rels/workbook.xml.rels",relations.append("<Relationship Id=\"styles\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/></Relationships>").toString());
            zip(output,"_rels/.rels","<?xml version=\"1.0\"?><Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"root\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>");
            zip(output,"xl/styles.xml","<?xml version=\"1.0\"?><styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><numFmts count=\"1\"><numFmt numFmtId=\"164\" formatCode=\"#,##0.00 &quot;€&quot;\"/></numFmts><fonts count=\"2\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font><font><b/><color rgb=\"FFFFFFFF\"/><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts><fills count=\"3\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill><fill><patternFill patternType=\"solid\"><fgColor rgb=\"FF126858\"/></patternFill></fill></fills><borders count=\"1\"><border/></borders><cellStyleXfs count=\"1\"><xf/></cellStyleXfs><cellXfs count=\"3\"><xf/><xf fontId=\"1\" fillId=\"2\" applyFill=\"1\" applyFont=\"1\"/><xf numFmtId=\"164\" applyNumberFormat=\"1\"/></cellXfs><cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>");
        }
    }
    private static String supported(PDType0Font font,String value)throws Exception{
        StringBuilder result=new StringBuilder();for(int i=0;i<value.length();){int cp=value.codePointAt(i);i+=Character.charCount(cp);String unit=new String(Character.toChars(cp));try{font.encode(unit);result.append(unit);}catch(IllegalArgumentException e){result.append("[U+").append(Integer.toHexString(cp).toUpperCase(Locale.US)).append(']');}}return result.toString();
    }
    private static List<String> wrap(PDType0Font font,String value,float width,float size)throws Exception{
        List<String> lines=new ArrayList<String>();String line="";
        for(String paragraph:value.replace('\r',' ').split("\n",-1)){
            for(String word:paragraph.split(" +",-1)){
                String next=line.isEmpty()?word:line+" "+word;
                if(font.getStringWidth(next)/1000*size<=width){line=next;continue;}
                if(!line.isEmpty()){lines.add(line);line="";}
                for(int i=0;i<word.length();){int cp=word.codePointAt(i);i+=Character.charCount(cp);String character=new String(Character.toChars(cp));if(!line.isEmpty()&&font.getStringWidth(line+character)/1000*size>width){lines.add(line);line="";}line+=character;}
            }
            lines.add(line);line="";
        }
        return lines;
    }
    private static void text(PDPageContentStream content,PDType0Font font,float size,float x,float y,String value)throws Exception{content.beginText();content.setFont(font,size);content.newLineAtOffset(x,y);content.showText(value);content.endText();}
    public static void writePdf(File target,JSONObject spec,InputStream fontStream)throws Exception{
        validate(spec);JSONObject table=spec.getJSONArray("tables").getJSONObject(0);JSONArray columns=table.getJSONArray("columns"),rows=table.getJSONArray("rows");if(rows.length()>3000)throw new IOException("Για PDF επίλεξε έως 3.000 γραμμές. Το Excel καλύπτει μεγαλύτερο διάστημα.");
        try(PDDocument document=new PDDocument()){
            PDType0Font font;try{font=PDType0Font.load(document,fontStream,true);}finally{fontStream.close();}
            float total=0;for(int c=0;c<columns.length();c++)total+=columns.getJSONObject(c).optInt("width",100);float[] widths=new float[columns.length()];for(int c=0;c<widths.length;c++)widths[c]=778f*columns.getJSONObject(c).optInt("width",100)/total;
            int row=0,lineOffset=0,pageNumber=0;List<List<String>> cells=null;boolean first=true;
            while(first||row<rows.length()){
                first=false;pageNumber++;PDPage page=new PDPage(new PDRectangle(842,595));document.addPage(page);
                try(PDPageContentStream content=new PDPageContentStream(document,page)){
                    content.setNonStrokingColor(21,59,54);text(content,font,16,32,558,supported(font,spec.getString("title")));
                    String subtitle=spec.optString("subtitle","");List<String> notes=wrap(font,supported(font,subtitle),778,9);float y=538;
                    for(String note:notes){text(content,font,9,32,y,note);y-=12;}y-=6;
                    float headerHeight=36;content.setNonStrokingColor(18,104,88);content.addRect(32,y-headerHeight,778,headerHeight);content.fill();content.setNonStrokingColor(255,255,255);float x=32;
                    for(int c=0;c<columns.length();c++){List<String> labels=wrap(font,supported(font,columns.getJSONObject(c).getString("label")),widths[c]-12,9);for(int l=0;l<labels.size();l++)text(content,font,9,x+6,y-13-l*11,labels.get(l));x+=widths[c];}y-=headerHeight;
                    while(row<rows.length()&&y>65){
                        if(cells==null){cells=new ArrayList<List<String>>();for(int c=0;c<columns.length();c++)cells.add(wrap(font,supported(font,display(rows.getJSONArray(row).get(c),columns.getJSONObject(c).optString("type","text"))),widths[c]-12,9));}
                        int lines=0;for(List<String> cell:cells)lines=Math.max(lines,cell.size());int available=(int)((y-48-12)/12),shown=Math.min(lines-lineOffset,available);if(shown<1)break;float height=shown*12+12;
                        if(row%2==0){content.setNonStrokingColor(239,247,243);content.addRect(32,y-height,778,height);content.fill();}content.setNonStrokingColor(21,59,54);x=32;
                        for(int c=0;c<columns.length();c++){List<String> cell=cells.get(c);for(int l=0;l<shown;l++){int at=lineOffset+l;if(at>=cell.size())continue;String value=cell.get(at);boolean number=columns.getJSONObject(c).optString("type").matches("money|integer");float left=number?x+widths[c]-6-font.getStringWidth(value)/1000*9:x+6;text(content,font,9,left,y-14-l*12,value);}x+=widths[c];}
                        y-=height;lineOffset+=shown;if(lineOffset>=lines){row++;lineOffset=0;cells=null;}
                    }
                    content.setNonStrokingColor(90,110,103);text(content,font,8,32,25,"Fleet Control - "+supported(font,table.getString("name")));text(content,font,8,733,25,"Page "+pageNumber);
                }
                if(pageNumber>1000)throw new IOException("Διάλεξε μικρότερο διάστημα PDF.");
            }
            document.save(target);
        }
    }
}
