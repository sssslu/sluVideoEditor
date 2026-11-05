"""Regenerate bundled-font cmap/ligature metadata. Requires fontTools; never used at runtime."""
from pathlib import Path
import hashlib, json
from fontTools.ttLib import TTFont
root=Path(__file__).resolve().parent.parent
def inspect(name,output,emoji=False):
    source=root/'src/assets/fonts'/name
    font=TTFont(source); cmap=font.getBestCmap(); points=sorted(cmap)
    ranges=[]; start=end=points[0]
    for point in points[1:]:
        if point==end+1: end=point
        else: ranges.append([start,end]); start=end=point
    ranges.append([start,end])
    data={'sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'ranges':ranges}
    if emoji:
        reverse={name:point for point,name in cmap.items()}
        sequences=set()
        for lookup in font['GSUB'].table.LookupList.Lookup:
            for sub in lookup.SubTable:
                for first,records in getattr(sub,'ligatures',{}).items():
                    for record in records:
                        glyphs=[first]+record.Component
                        if all(glyph in reverse for glyph in glyphs): sequences.add(''.join(chr(reverse[glyph]) for glyph in glyphs))
        data['sequences']=sorted(sequences)
        data['variation16']=sorted({point for sub in font['cmap'].tables for point,_ in getattr(sub,'uvsDict',{}).get(65039,[])})
    (root/'src/assets/fonts'/output).write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')),encoding='utf8')
    print(name,len(points),'codepoints',len(ranges),'ranges',len(data.get('sequences',[])),'sequences')
inspect('NotoSansKR-VF.ttf','NotoSansKR-coverage.json')
inspect('NotoColorEmoji.ttf','NotoEmoji-coverage.json',True)
