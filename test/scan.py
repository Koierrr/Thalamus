import sys
sys.stdout.reconfigure(encoding='utf-8')
src = open('C:/Users/koier/AppData/Local/Temp/conjs.js', encoding='utf-8').read()
depth = {'p': 0, 'b': 0, 's': 0}
pairs = {')': 'p', '}': 'b', ']': 's'}
opens = {'(': 'p', '{': 'b', '[': 's'}
line = 1
in_s = None
esc = False
stack = []
for ch in src:
    if ch == chr(10):
        line += 1
    if in_s:
        if esc:
            esc = False
        elif ch == chr(92):
            esc = True
        elif ch == in_s:
            in_s = None
        continue
    if ch in ('"', "'"):
        in_s = ch
        continue
    if ch in opens:
        depth[opens[ch]] += 1
        stack.append((opens[ch], line))
    elif ch in pairs:
        depth[pairs[ch]] -= 1
        if stack:
            stack.pop()
        if depth[pairs[ch]] < 0:
            print('多余闭合于行', line, ':', ch)
            depth[pairs[ch]] = 0
print('最终深度:', depth)
print('结束于行:', line, '/ 总行数:', src.count(chr(10)) + 1)
if stack:
    print('未闭合的构造（类型, 开始行）——最后5个:')
    for t, l in stack[-5:]:
        print('  ', t, '开始于行', l)
